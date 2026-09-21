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
 *   - `_failureCount`          0 after a poll the device answered, counted up otherwise
 *   - `get pollDefaultS()`     interval used when the setting is unusable
 *   - `get pollMinS()`         lowest interval accepted from the setting
 *
 * `_failureCount` was always written by all eight; it is named here because _learnMac now
 * reads it, and a contract that leaves out what is read is how the eight copies drifted.
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

const { normalizeMac } = require('./mac-vendor');

// Where the learned MAC lives on the device. The store rather than the settings, because
// it is not a choice anybody made: nobody should have to look at it, and nobody should be
// able to get it wrong.
const MAC_ANCHOR_KEY = 'macAnchor';

// How long to wait for Homey's neighbour table. ManagerArp#getMAC is documented as
// returning a string and says nothing at all about an address that never answered — not
// what comes back, and not how long it may take to say so. This runs on the poll timer
// where nobody is waiting for the answer, so the budget is small and a miss costs nothing:
// the next poll asks again.
const ARP_TIMEOUT_MS = 2000;

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
    // Clear first, always. Starting twice used to leave the earlier timer running with
    // nothing holding its handle: `_stopPolling` can only ever reach whatever is in the
    // field, so the older loop kept polling forever and no amount of stopping could reach
    // it. Two readers are enough to cause it — one pauses while the other is still paused,
    // so the second pause finds nothing to clear, and then both resume. Since 1.2.245 four
    // code paths pause and resume around a read, which made a latent bug a reachable one.
    await this._stopPolling();

    this._timer = this.homey.setInterval(() => {
      // `_fetchAndUpdate` resolves on every path it has — the two re-entry guards, the
      // missing-address return, the plausibility abort and its own caught Modbus error all
      // end in a resolved promise — so `.then` on its own says nothing about whether the
      // device answered. Two fields the mixin contract already names do say it: every
      // driver sets `_lastPollStart` immediately after its guards, so a changed value means
      // a poll really began, and only the success block puts `_failureCount` back to zero.
      //
      // The distinction is the whole point. Learning a MAC after a failed poll would read
      // whatever now holds the old address and write it down as this device's — the one
      // mistake that makes the anchor worse than no anchor.
      const startedBefore = this._lastPollStart;
      this._fetchAndUpdate()
        .then(() => {
          if (this._lastPollStart !== startedBefore && this._failureCount === 0) {
            return this._learnMac();
          }
          return undefined;
        })
        .catch((err) => {
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

  /**
   * Remember the MAC address behind the IP that just answered.
   *
   * An IP address is not a name. The router is free to hand it to a different machine next
   * week, and then the setting still reads like an address, the address still answers a
   * ping, and nothing behind it is this device any more. A MAC travels with the hardware,
   * so it is the one thing that can later say "this is the same device, at a new address"
   * rather than "something is at the address we remember".
   *
   * Learned rather than asked for: the anchor comes from an address that has just carried
   * a successful poll, so an installation that has been running for years grows one on its
   * next tick — no migration, no pairing again, nobody typing anything.
   *
   * Re-learned when the address changes, because an address the owner corrected by hand may
   * well be different hardware. Never throws: this hangs off the poll timer, where a
   * rejection has nobody to catch it and would take the timer down with it.
   */
  async _learnMac() {
    try {
      const address = this.getSetting('address');
      if (!address) return;

      const anchor = this.getStoreValue(MAC_ANCHOR_KEY);
      if (anchor && anchor.mac && anchor.address === address) return;

      const arp = this.homey && this.homey.arp;
      if (!arp || typeof arp.getMAC !== 'function') {
        // Said once per device, never on every poll. On a Homey with no neighbour table the
        // whole anchor is inert, and staying silent about that leaves it looking exactly
        // like the healthy case — an anchor that simply has nothing to report yet.
        if (!this._arpMissingLogged) {
          this._arpMissingLogged = true;
          this.log('No ARP on this Homey — no MAC anchor, so a device that changes address cannot be recognised at its new one.');
        }
        return;
      }

      // The raw promise gets its own catch as well as the race. A rejection that arrives
      // after the timeout has already won would otherwise be an unhandled rejection in the
      // app process — the same reason lib/modbus-client.js guards its own late sockets.
      const lookup = arp.getMAC(address);
      if (lookup && typeof lookup.then === 'function') lookup.catch(() => {});

      const raw = await Promise.race([
        lookup,
        new Promise((resolve) => { this.homey.setTimeout(() => resolve(null), ARP_TIMEOUT_MS); }),
      ]);

      // Anything that is not a MAC is treated as "no answer", not as an answer worth
      // keeping. Homey promises a string and nothing about its shape, so nothing here
      // assumes one — and an all-zero MAC is the neighbour table saying it does not know.
      const mac = normalizeMac(raw);
      if (!mac) return;

      // Port and unit ID ride along as a record of what the anchor was learned from. They
      // are never matched on and never rewritten later: DHCP moves an address, it does not
      // move a port, and three devices routinely share one host:port:unit behind a dongle.
      const port   = parseInt(this.getSetting('port'), 10);
      const unitId = parseInt(this.getSetting('modbus_id'), 10);

      await this.setStoreValue(MAC_ANCHOR_KEY, {
        mac,
        address,
        port:   Number.isFinite(port)   ? port   : null,
        unitId: Number.isFinite(unitId) ? unitId : null,
        at:     new Date().toISOString(),
      });
      this.log(`MAC anchor learned: ${mac} at ${address}`);
    } catch (err) {
      this.log('_learnMac failed:', err.message);
    }
  },

};

// Exposed for the tests, but non-enumerable on purpose: module.exports IS the mixin, and
// Object.assign copies enumerable own properties — plain assignments would land these two
// numbers on every device prototype as stray members.
Object.defineProperty(module.exports, 'WATCHDOG_EVERY_MS', { value: WATCHDOG_EVERY_MS });
Object.defineProperty(module.exports, 'WATCHDOG_STUCK_MS', { value: WATCHDOG_STUCK_MS });
Object.defineProperty(module.exports, 'MAC_ANCHOR_KEY',    { value: MAC_ANCHOR_KEY });
Object.defineProperty(module.exports, 'ARP_TIMEOUT_MS',    { value: ARP_TIMEOUT_MS });
