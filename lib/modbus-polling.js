'use strict';

/**
 * Shared polling machinery for the Modbus device drivers.
 *
 * These four methods were byte-identical in all eight of them — roughly 7'600 characters
 * that existed only as copies, so every fix had to be found once and applied eight times.
 * This repo has already had a literal-text patch quietly miss one of the eight because
 * its line endings differ from the rest; that is the failure mode this removes.
 *
 * Applied as a plain method object rather than a base class, matching lib/ems/*: a class
 * extending Homey's Device would drag `require('homey')` in and could not be unit-tested,
 * which is precisely how the copies escaped scrutiny in the first place.
 *
 *     const modbusPolling = require('../../lib/modbus-polling');
 *     class FooDevice extends Device { ... }
 *     Object.assign(FooDevice.prototype, modbusPolling);
 *
 * The host driver must provide:
 *   - `_fetchAndUpdate()`      one poll; sets `_fetchInProgress` / `_lastPollStart`
 *   - `get pollDefaultS()`     interval used when the setting is unusable
 *   - `get pollMinS()`         lowest interval accepted from the setting
 *
 * pollDefaultS is a getter per driver, not a constant here, because the value genuinely
 * differs — the EMMA smart charger polls every 30 s where everything else polls every 60.
 * Reading it from the driver keeps that difference visible in the driver, and stopped
 * this very extraction from silently doubling the charger's interval.
 */

// Fallbacks, only reachable if a driver forgets the getters. test/modbus-polling.test.js
// asserts every Modbus driver declares both, so this should never fire in practice — it
// exists so a mistake degrades to "polls at 60 s and says so" rather than to a throw
// inside the interval callback, which would stop the device polling altogether.
const FALLBACK_DEFAULT_S = 60;
const FALLBACK_MIN_S     = 10;

const WATCHDOG_EVERY_MS  = 60_000;
// A poll that has claimed the in-progress flag for longer than this is not slow, it is
// lost: the Modbus client's own connect and response timeouts are far below it.
const WATCHDOG_STUCK_MS  = 120_000;

// _set is not Modbus-specific and the OpenAPI drivers need it too, so it lives on its
// own; spread in here to keep this one require enough for a Modbus driver.
const capabilitySet = require('./capability-set');

module.exports = {

  ...capabilitySet,

  _intervalMs() {
    let def = this.pollDefaultS;
    let min = this.pollMinS;
    if (!Number.isFinite(def) || !Number.isFinite(min)) {
      this.error(`${this.constructor.name}: pollDefaultS/pollMinS not declared — falling back to ${FALLBACK_DEFAULT_S}s`);
      def = FALLBACK_DEFAULT_S;
      min = FALLBACK_MIN_S;
    }
    let s = parseInt(this.getSetting('poll_interval'), 10);
    if (!Number.isFinite(s) || s < min) s = def;
    return s * 1000;
  },

  async _startPolling() {
    this._timer = this.homey.setInterval(() => {
      this._fetchAndUpdate().catch((err) => {
        this.error('Poll failed:', err.message);
      });
    }, this._intervalMs());

    // `_fetchInProgress` is owned by the driver's _fetchAndUpdate and normally cleared in
    // its finally. It can only stay set if that promise never settles at all, which the
    // per-host lock in modbus-client makes conceivable; without this the device would
    // then never poll again and look merely quiet rather than broken.
    this._watchdogTimer = this.homey.setInterval(() => {
      if (this._fetchInProgress) {
        const staleSec = Math.round((Date.now() - this._lastPollStart) / 1000);
        if (staleSec > WATCHDOG_STUCK_MS / 1000) {
          this.error('Watchdog: _fetchInProgress stuck for ' + staleSec + 's — resetting');
          this._fetchInProgress = false;
        }
      }
    }, WATCHDOG_EVERY_MS);
  },

  async _stopPolling() {
    if (this._timer) {
      this.homey.clearInterval(this._timer);
      this._timer = null;
    }
    if (this._watchdogTimer) {
      this.homey.clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  },

};

// Exposed for the tests, but non-enumerable on purpose: module.exports IS the mixin, and
// Object.assign copies enumerable own properties — plain assignments would land these two
// numbers on every device prototype as stray members.
Object.defineProperty(module.exports, 'WATCHDOG_EVERY_MS', { value: WATCHDOG_EVERY_MS });
Object.defineProperty(module.exports, 'WATCHDOG_STUCK_MS', { value: WATCHDOG_STUCK_MS });
