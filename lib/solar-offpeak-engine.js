'use strict';

// ─── Solar Surplus + Off-Peak Engine ─────────────────────────────────
//
// Adapted from homey-huawei-ev-charger for Repo A's multi-device architecture.
// Field name mappings vs the single-device reference:
//   device.transactionId       → device._txnId
//   device.autoStartBlocked    → device._autoStartBlocked
//   device.connectionStartTime → device._connectionStart
//   device.lastRequestedAmps   → device._txnAmps
//
// Two automation modes layered on top of the proven session machinery
// (masked pause, stitched sessions, power-verified starts):
//
//   Mode 1 — Off-peak scheduler: minute ticker that starts charging at
//   the configured off-peak current inside a tariff window and stops
//   ONLY sessions it started itself at window end.
//
//   Mode 2 — Solar surplus engine: 30-second loop fed by flow action
//   cards (production / grid / battery SOC / battery power). Starts a
//   session when sustained surplus covers the hardware floor, tracks
//   production up/down the 6/8/10/12/14/16A ladder, masked-pauses through
//   cloud gaps, and stitched-resumes when the sun returns.
//
// PRIME DIRECTIVE: the engine only governs sessions IT started (tracked
// via device.sessionOwner: 'user' | 'solar' | 'offpeak'). Manual buttons,
// user flows, and EMMA's morning battery window are sovereign — never
// stepped, paused, or stopped by this code. Any manual intervention on an
// engine-owned session (limit change, pause, resume) hands ownership to
// the user and the engine backs off.
//
// The valid power ladder on this hardware (numberPhases in OCPP profiles
// is IGNORED by the firmware — watts always spread across the physical
// phases): 6/8/10/12/14/16A × physical phases × 230V. On a tri-phase unit
// that's 4.1 / 5.5 / 6.9 / 8.2 / 11.0 kW, floor 4.14 kW.

const LADDER_AMPS = [6, 8, 10, 12, 14, 16];
const STALE_INPUT_MS = 5 * 60 * 1000; // any feeder input older than this suspends the engine
// Home-battery discharge below this is treated as measurement flutter
// around zero, not as the house drawing on storage. Well below one ladder
// step (1.38 kW between steps on tri-phase), so its exact value is not
// critical; revisit with log evidence if a specific battery proves twitchy.
const BATTERY_DISCHARGE_DEADBAND_W = 100;
const SOLAR_TICK_MS = 30 * 1000;
const OFFPEAK_TICK_MS = 60 * 1000;

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

class SolarOffpeakEngine {

  constructor(device) {
    this.device = device;
    this._engineStartedAt = Date.now();
    this._solarInterval = null;
    this._offpeakInterval = null;

    // Feeder inputs (flow-fed, Option B). Values carry freshness
    // timestamps; deliberately NOT persisted — after an app restart the
    // data is stale by definition, and stale data must suspend the
    // engine rather than drive it.
    this.inputs = {
      production_w: null,   // { value, at }
      grid_w: null,         // +import / −export
      battery_soc: null,
      battery_power_w: null,
    };

    // Solar state machine timers (transient by design)
    this._surplusSince = null;      // sustained-surplus tracking (start / resume)
    this._belowFloorSince = null;   // stop-grace tracking
    this._pendingStepAmps = null;   // step-hold tracking
    this._pendingStepSince = null;
    this._importSince = null;       // grid-import streak (anti-thrash guardrails)
    this._lastDownStepAt = null;    // direction-flip cooldown anchor
    this._staleSuspended = false;   // edge-detect for the stale-data log/pause

    // User-sovereignty suppression: a manual stop of an engine session
    // means "leave it alone" — solar until the next plug-in, off-peak for
    // the rest of the current window instance.
    this._solarSuppressedConnection = null;
    this._offpeakSuppressedWindowId = null;
    this._lastTickOpen = false;       // previous off-peak tick's window state,
    this._lastTickWindowId = null;    // for suppression continuity across overlaps

    // Adaptive car phases: how many phases THIS car actually draws on,
    // estimated from measured draw vs the requested amps. A 2-phase hybrid
    // at 8A pulls 3.68 kW, not the 5.52 kW a tri-phase car would — pricing
    // ladder steps at the tri-phase rate leaves surplus exported that the
    // car could take. Rules: trusted only above 500W of real draw, adopted
    // after two consecutive agreeing ticks, and NEVER revised downward on
    // the same plug-in (cars don't grow straws mid-charge; a downward drift
    // is the end-of-charge taper, which must not reprice the ladder).
    // Reset when the cable is re-plugged (a different car may arrive).
    this._effPhases = null;
    this._effPhasesConnection = null;
    this._effPhasesCandidate = null;
  }

  start() {
    this.stop();
    this._solarInterval = this.device.homey.setInterval(() => {
      this._solarTick().catch((err) => this.device.log(`Solar engine tick error: ${err.message}`));
    }, SOLAR_TICK_MS);
    this._offpeakInterval = this.device.homey.setInterval(() => {
      this._offpeakTick().catch((err) => this.device.log(`Off-peak tick error: ${err.message}`));
    }, OFFPEAK_TICK_MS);
    this.device.log('Solar/off-peak engine started (solar loop 30s, off-peak ticker 60s)');
  }

  stop() {
    if (this._solarInterval) {
      this.device.homey.clearInterval(this._solarInterval);
      this._solarInterval = null;
    }
    if (this._offpeakInterval) {
      this.device.homey.clearInterval(this._offpeakInterval);
      this._offpeakInterval = null;
    }
  }

  // ─── Feeder inputs ───────────────────────────────────────────────

  feedInput(key, value) {
    if (!(key in this.inputs)) {
      throw new Error(`Unknown solar input: ${key}`);
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid value for ${key}: ${value}`);
    }
    if (key === 'battery_soc' && (num < 0 || num > 100)) {
      throw new Error(`Battery SOC must be 0–100%, got ${num}`);
    }
    this.inputs[key] = { value: num, at: Date.now() };
    // Persist so a restart can restore recent values (see restoreInputs).
    // Fire-and-forget: a failed persist only costs restart smoothness.
    this.device.setStoreValue('solarInputs', this.inputs).catch(() => {});
  }

  // Restore feeder inputs persisted before a restart — but only those
  // still inside the same 5-minute freshness window the live engine
  // enforces. The timestamps are the originals, so restored values age
  // out on exactly the same clock as live ones: nothing older is ever
  // trusted, an app reboot just stops erasing what was already fresh.
  // With feeders ticking every minute this makes restarts seamless —
  // no masked pause, no 180s re-sustain.
  async restoreInputs() {
    let stored = null;
    try { stored = await this.device.getStoreValue('solarInputs'); } catch (err) { return; }
    if (!stored) return;
    const now = Date.now();
    let restored = 0;
    for (const key of Object.keys(this.inputs)) {
      const v = stored[key];
      if (v && typeof v.value === 'number' && typeof v.at === 'number' && (now - v.at) < 5 * 60 * 1000) {
        this.inputs[key] = v;
        restored++;
      }
    }
    if (restored > 0) {
      this.device.log(`Solar inputs restored across restart: ${restored} value(s) still fresh`);
    }
  }

  _inputAge(key) {
    const inp = this.inputs[key];
    return inp ? (Date.now() - inp.at) : Infinity;
  }

  _inputValue(key) {
    const inp = this.inputs[key];
    return inp ? inp.value : null;
  }

  // ─── User-sovereignty hooks (called from device.js) ───────────────

  // A user explicitly stopped an engine-owned session: back off.
  noteUserStop(owner) {
    if (owner === 'solar') {
      this._solarSuppressedConnection = this.device._connectionStart || 'no-connection-marker';
      this.device.log('Solar engine: user stopped a solar session — engine suppressed until the next plug-in');
    } else if (owner === 'offpeak') {
      const w = this._computeWindow(new Date());
      this._offpeakSuppressedWindowId = w.open ? w.windowId : null;
      this.device.log('Off-peak scheduler: user stopped an off-peak session — scheduler suppressed for the rest of this window');
    }
    this._resetSolarTimers();
  }

  // Escape hatch for a mistaken or reconsidered manual stop: without this,
  // the only way out of a suppression is physically re-plugging the cable
  // (solar) or waiting out the window (off-peak). Cleared by the
  // 'Re-enable automatic charging' flow card, the maintenance button, or
  // toggling the mode off→on in settings (the universal reset gesture).
  clearSuppression(scope) {
    const which = scope || 'all';
    if ((which === 'all' || which === 'solar') && this._solarSuppressedConnection !== null) {
      this._solarSuppressedConnection = null;
      this.device.log('Solar suppression cleared — automatic solar charging may start again on this plug-in');
    }
    if ((which === 'all' || which === 'offpeak') && this._offpeakSuppressedWindowId !== null) {
      this._offpeakSuppressedWindowId = null;
      this.device.log('Off-peak suppression cleared — the scheduler may start again inside this window');
    }
  }

  _resetSolarTimers() {
    this._surplusSince = null;
    this._belowFloorSince = null;
    this._pendingStepAmps = null;
    this._pendingStepSince = null;
  }

  // ─── Shared helpers ────────────────────────────────────────────────

  _setting(key, fallback) {
    const v = this.device.getSetting(key);
    return (v === null || v === undefined || v === '') ? fallback : v;
  }

  _ladderWatts() {
    const phases = this.device._devicePhases();
    return LADDER_AMPS.map((a) => ({ amps: a, watts: a * phases * 230 }));
  }

  // Phases the CURRENT car is known to draw on (defaults to the physical
  // phase count until proven otherwise — the conservative direction)
  _carPhases() {
    const conn = this.device._connectionStart || 'no-connection-marker';
    if (this._effPhases !== null && this._effPhasesConnection === conn) {
      return this._effPhases; // measured THIS session — strongest truth
    }
    const phys = this.device._devicePhases();
    const rem = this.device._rememberedCarPhases;
    if (rem === 1 || rem === 2 || rem === 3) {
      return Math.min(rem, phys); // remembered from a previous session
    }
    return phys; // never measured anything — conservative physical count
  }

  _carPhaseSource() {
    const conn = this.device._connectionStart || 'no-connection-marker';
    if (this._effPhases !== null && this._effPhasesConnection === conn) return 'measured';
    const rem = this.device._rememberedCarPhases;
    if (rem === 1 || rem === 2 || rem === 3) return 'remembered';
    return 'physical';
  }

  _carPhasesDetected() {
    const conn = this.device._connectionStart || 'no-connection-marker';
    return this._effPhases !== null && this._effPhasesConnection === conn;
  }

  // Ladder priced for THIS car — what each step would actually cost in watts
  _effLadderWatts() {
    const phases = this._carPhases();
    return LADDER_AMPS.map((a) => ({ amps: a, watts: a * phases * 230 }));
  }

  _effStepFor(watts) {
    let best = null;
    for (const step of this._effLadderWatts()) {
      if (step.watts <= watts) best = step;
    }
    return best;
  }

  // Battery-charging power may BOOTSTRAP the lowest step only — while the
  // home battery is still filling (gate open, FusionSolar still feeding
  // it), the car may claim that power for the minimum step, never for
  // climbing. Climbing requires real export, which appears naturally as
  // the battery approaches 100% and its charging tapers to zero.
  _stepWithBootstrap(realAvailW, chargeW, socOk) {
    const step = this._effStepFor(realAvailW);
    if (step) return { step, bootstrapped: false };
    if (socOk && chargeW > 0) {
      const boot = this._effStepFor(realAvailW + chargeW);
      if (boot) {
        const lowest = this._effLadderWatts()[0];
        return { step: lowest, bootstrapped: true };
      }
    }
    return { step: null, bootstrapped: false };
  }

  _updateEffPhases(carW, currentAmps) {
    if (!currentAmps || carW < 500) return;
    const conn = this.device._connectionStart || 'no-connection-marker';
    if (this._effPhasesConnection !== conn) {
      // new plug-in — forget the previous car
      this._effPhases = null;
      this._effPhasesCandidate = null;
      this._effPhasesConnection = conn;
    }
    const phys = this.device._devicePhases();
    let est = Math.round(carW / (currentAmps * 230));
    if (est < 1) est = 1;
    if (est > phys) est = phys;
    // Upward-only once adopted (taper protection); two agreeing ticks to adopt
    if (this._effPhases !== null && est <= this._effPhases) {
      this._effPhasesCandidate = null;
      return;
    }
    if (this._effPhasesCandidate === est) {
      const before = this._effPhases;
      this._effPhases = est;
      this._effPhasesCandidate = null;
      // Remember the car BETWEEN plug-ins (and across app restarts): the
      // floor at the next plug-in is priced with this instead of the
      // physical worst case — a 2-phase hybrid's 6A floor is 2.8 kW, so
      // a 4.0 kW export finally starts charging instead of waiting on a
      // 4.14 kW tri-phase floor forever. Live detection still runs every
      // session and rewrites this if a different car shows up.
      this.device._rememberedCarPhases = est;
      if (typeof this.device.setStoreValue === 'function') {
        Promise.resolve(this.device.setStoreValue('rememberedCarPhases', est)).catch(() => {});
      }
      this.device.log(`Car draws on ${est} phase(s) (${Math.round(carW)}W at ${currentAmps}A)${before ? ` — revised up from ${before}` : ''} — charging steps repriced and remembered for the next plug-in`);
    } else {
      this._effPhasesCandidate = est;
    }
  }

  // Highest ladder step covered by the given watts, or null if below floor
  _stepFor(watts) {
    const ladder = this._ladderWatts();
    let best = null;
    for (const step of ladder) {
      if (step.watts <= watts) best = step;
    }
    return best;
  }

  // Car connected with no ACTIVE session the engine would collide with.
  // A blocked auto-start transaction (open at 1W, _autoStartBlocked) counts
  // as startable — startCharging() raises it, which is exactly the smart-
  // charging plug-in state the engine is designed to drive.
  _canStartSession() {
    const d = this.device;
    if (d.chargerOffline) return false;
    if (d.stitchedSession) return false; // a paused logical session exists — handled by owner-specific paths
    if (d._txnId && !d._autoStartBlocked) return false;
    const state = d.getCapabilityValue('evcharger_charging_state');
    if (state !== 'connected') return false;
    // Car concluded full (charger's Local stop, cleared on fresh plug-in):
    // one start attempt per plug-in — the charger told us the battery is
    // full, re-poking it every tick would loop start/stop forever.
    if (d.lastStopReason === 'Local') return false;
    return true;
  }

  // ─── Mode 1: Off-peak scheduler ────────────────────────────────────

  _parseTime(str) {
    const m = TIME_RE.exec(String(str || '').trim());
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  _windowFor(isWeekend) {
    const differs = this._setting('offpeak_weekend_differs', false) === true;
    const prefix = (isWeekend && differs) ? 'offpeak_weekend' : 'offpeak_weekday';
    return {
      start: this._parseTime(this._setting(`${prefix}_start`, '22:00')),
      end: this._parseTime(this._setting(`${prefix}_end`, '06:00')),
    };
  }

  // Is the off-peak window open at `now`? PER-DAY semantics, matching how
  // day-based tariffs actually meter: each calendar day is cheap BEFORE its
  // own morning end and AFTER its own evening start (for overnight-style
  // windows where start > end). So a night window's morning portion is
  // defined by the day it ENDS on — Friday 22:00 with weekday end 07:00 /
  // weekend end 17:00 runs until SATURDAY 17:00, and Sunday 22:00 runs
  // until MONDAY 07:00. (The originally shipped start-day governance got
  // both of those wrong for real split weekend tariffs: it missed Saturday
  // daytime and overshot into Monday peak hours.)
  // - Plain daytime windows (start < end) are a same-day interval, no tails.
  // - The morning tail only exists if YESTERDAY's window was overnight-style
  //   (its evening actually opened); a night can't spill past midnight into
  //   a day whose own definition has no overnight morning.
  // windowId identifies the continuous open period (the day whose evening
  // opened it), used for per-window user-stop suppression — under these
  // semantics the id is stable across midnight within one open period.
  // Homey Pro's Node clock runs in UTC — the user's wall clock lives in
  // homey.clock.getTimezone(). ALL window math must use wall time, or a
  // 22:00 window opens at midnight (observed live on hardware, v2.0.0).
  _tz() {
    try {
      return (this.device.homey && this.device.homey.clock
        && this.device.homey.clock.getTimezone()) || 'UTC';
    } catch (err) {
      return 'UTC';
    }
  }

  _wallParts(date) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: this._tz(), hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    const g = {};
    for (const p of fmt.formatToParts(date)) g[p.type] = p.value;
    const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      day: WD[g.weekday],
      minutesOfDay: (parseInt(g.hour, 10) % 24) * 60 + parseInt(g.minute, 10),
      dateKey: `${g.year}-${g.month}-${g.day}`,
    };
  }

  _computeWindow(now) {
    const parts = this._wallParts(now);
    const day = parts.day; // 0=Sun … 6=Sat, in the USER's timezone
    const isWeekend = (d) => d === 0 || d === 6;
    const t = parts.minutesOfDay;

    const dayKey = (offsetDays) => {
      // Wall-clock date identity: shift by whole days in epoch time, then
      // read the date IN THE USER'S timezone — the UTC date flips at a
      // different moment than local midnight, which would change a window
      // instance's identity mid-window and drop user-stop suppression.
      return this._wallParts(new Date(now.getTime() + offsetDays * 86400000)).dateKey;
    };

    const wToday = this._windowFor(isWeekend(day));
    if (wToday.start === null || wToday.end === null) return { open: false, windowId: null };

    if (wToday.start < wToday.end) {
      // Plain daytime window: a same-day interval
      if (t >= wToday.start && t < wToday.end) return { open: true, windowId: dayKey(0) };
      return { open: false, windowId: null };
    }

    if (wToday.start > wToday.end) {
      // Overnight-style day: evening portion belongs to today…
      if (t >= wToday.start) return { open: true, windowId: dayKey(0) };
      // …and the morning portion (t < TODAY's end) belongs to yesterday's
      // window — provided yesterday's evening actually opened
      if (t < wToday.end) {
        const yesterday = (day + 6) % 7;
        const wYest = this._windowFor(isWeekend(yesterday));
        if (wYest.start !== null && wYest.end !== null && wYest.start > wYest.end) {
          return { open: true, windowId: dayKey(-1) };
        }
      }
    }

    return { open: false, windowId: null };
  }

  // "Solar first inside the window": with daytime off-peak windows (split
  // weekend tariffs), FREE energy should outrank CHEAP energy — verified by
  // simulation: without this guard, the minute ticker starts 16A within
  // 60s while solar is still proving its 180s sustain, and the car then
  // imports ~5 kW of (cheap) grid past the available sun, forever, because
  // off-peak sessions have no surplus logic. The guard defers the
  // scheduler's start/adoption whenever solar could plausibly claim the
  // plug-in RIGHT NOW: solar enabled + feeds fresh + SOC gate open +
  // surplus covering the floor. Clouds/night/low battery/stale feeds →
  // guard inactive → scheduler behaves exactly as before.
  _hasBattery() {
    return this._setting('solar_has_battery', true) !== false;
  }

  // Battery-aware reads: without a battery, the minimum is 0 and
  // discharge counting is off — the two battery inputs become inert.
  _minSoc() {
    if (!this._hasBattery()) return 0;
    return parseInt(this._setting('solar_min_battery_soc', 90), 10) || 0;
  }

  _countDischarge() {
    return this._hasBattery()
      && this._setting('solar_count_battery_discharge', true) !== false;
  }

  _solarCouldClaim() {
    if (this._setting('offpeak_solar_first', true) === false) return false;
    if (this._setting('solar_enabled', false) !== true) return false;
    if (!this._inputsFresh()) return false;
    const minSoc = this._minSoc();
    const soc = this._inputValue('battery_soc');
    if (minSoc > 0 && (soc === null || soc < minSoc)) return false;
    // No engine session is charging in the deferral scenarios (start /
    // adoption), so carW = 0; priced for the remembered car when known
    const surplus = this._computeAvailable(0);
    const socOkHere = this._minSoc() <= 0
      || ((this._inputValue('battery_soc') || 0) >= this._minSoc());
    return this._stepWithBootstrap(surplus.availableW, surplus.chargeW, socOkHere).step !== null;
  }

  async _offpeakTick() {
    const d = this.device;
    // Re-entrancy / mutual-exclusion guard (shared with the solar tick):
    // a RemoteStart with its quick-abort auto-retry can take 60–90s, and
    // during that await the transaction id is still null — an interleaving
    // tick (this one 60s later, or the 30s solar tick) would read "no
    // session" and start a SECOND one. One in-flight decision at a time,
    // and never while the device itself has a start in flight (e.g. the
    // user pressed Charge Now a moment ago).
    if (this._tickBusy || d._startInFlight) return;
    this._tickBusy = true;
    try {
      return await this._offpeakTickInner();
    } finally {
      this._tickBusy = false;
    }
  }

  async _offpeakTickInner() {
    const d = this.device;
    if (this._setting('offpeak_enabled', false) !== true) return;

    const win = this._computeWindow(new Date());

    // Suppression continuity: a user-stop suppression is meant to last for
    // the whole CONTINUOUS open period, but overlapping definitions can
    // change the window's identity mid-period (e.g. weekday Fri 22:00→07:00
    // overlapping weekend Sat 00:00→17:00 — at midnight the id flips from
    // Friday's instance to Saturday's while the window never closed). If the
    // window was open on the previous tick under the suppressed id and is
    // still open now under a new id, carry the suppression forward —
    // otherwise the scheduler would restart at midnight what the user
    // stopped at 23:30.
    if (win.open && this._offpeakSuppressedWindowId
      && this._offpeakSuppressedWindowId !== win.windowId
      && this._lastTickOpen && this._lastTickWindowId === this._offpeakSuppressedWindowId) {
      d.log('Off-peak: window identity changed mid-open-period — carrying the user-stop suppression forward');
      this._offpeakSuppressedWindowId = win.windowId;
    }
    this._lastTickOpen = win.open;
    this._lastTickWindowId = win.windowId;

    if (!win.open) {
      this._offpeakSuppressedWindowId = null;
      // Window closed: stop ONLY what the scheduler itself started.
      // Sovereign sessions (a manual 20:00 charge, EMMA's morning battery
      // window) run untouched straight through the boundary.
      if (d.sessionOwner === 'offpeak' && (d._txnId || (d.stitchedSession && d.stitchedSession.paused))) {
        d.log('Off-peak window ended — stopping the scheduler\'s own session');
        try {
          await d.stopCharging('engine');
        } catch (err) {
          d.log(`Off-peak window-end stop failed: ${err.message}`);
        }
      }
      return;
    }

    // Window open
    if (d.chargerOffline) return;
    if (this._offpeakSuppressedWindowId === win.windowId) return; // user said stop — respect it for this window

    const amps = parseInt(this._setting('offpeak_amps', '16'), 10) || 16;

    // A solar session sitting masked-paused at window start (sun gone,
    // cheap tariff arrived): ADOPT and resume it at off-peak power — the
    // stitched machinery reports it as ONE continuous session spanning
    // sun + night.
    if (d.stitchedSession && d.stitchedSession.paused && d.stitchedSession.owner === 'solar') {
      if (this._solarCouldClaim()) {
        // Surplus is back and solar can resume this itself (free beats
        // cheap); adoption is for clouds and nightfall, when it can't
        return;
      }
      d.log(`Off-peak window open — adopting the paused solar session and resuming at ${amps}A`);
      d.stitchedSession.owner = 'offpeak';
      d.sessionOwner = 'offpeak';
      d._txnAmps = amps;
      d.stitchedSession.resumeAmps = amps;
      await d._persistStitched();
      try {
        await d.resumeCharging('engine');
      } catch (err) {
        d.log(`Off-peak adopt/resume failed: ${err.message}`);
      }
      return;
    }

    // Fresh start inside the window (covers both "window opens with the
    // car already connected" and "plug-in mid-window": this ticks every
    // minute, so either way the next tick starts it).
    if (this._canStartSession()) {
      if (this._solarCouldClaim()) {
        return; // solar-first: let the solar machinery earn this plug-in
      }
      d.log(`Off-peak window open, car connected, no session — starting at ${amps}A`);
      try {
        await d.startCharging(amps, undefined, 'offpeak');
      } catch (err) {
        d.log(`Off-peak start failed: ${err.message}`);
      }
    }
    // Car full before window end → the charger's own Local stop handles it
    // (existing machinery); lastStopReason==='Local' then blocks re-attempts.
  }

  // ─── Mode 2: Solar surplus engine ──────────────────────────────────

  _inputsFresh() {
    if (this._inputAge('production_w') > STALE_INPUT_MS) return false;
    if (this._inputAge('grid_w') > STALE_INPUT_MS) return false;
    // Battery SOC is only REQUIRED when the battery-first gate is in play
    if (this._minSoc() > 0
      && this._inputAge('battery_soc') > STALE_INPUT_MS) return false;
    return true;
  }

  // Available surplus for the car. grid_w is +import/−export; what the car
  // draws is already inside that balance, so:
  //   available = carDraw − gridImport − batteryDischarge + tolerance
  // The battery term (opt-out via the 'solar_count_battery_discharge'
  // setting, default on): EMMA holds the grid at ~0 by bridging house
  // loads from the battery, which would otherwise mask a vanished surplus
  // from the grid meter entirely — sunset and big-load-while-sunny both
  // show up as discharge before they show up as import. Discharge counts
  // as import from your own storage; battery CHARGING never adds to
  // available (that's the battery-first claim on the surplus, enforced by
  // FusionSolar and our SOC gate). Discharge below the deadband is
  // flutter and ignored. The term only participates while battery power
  // is actually fed and fresh — never-fed or stale quietly drops it
  // (conservative in the optimistic direction, flagged on the Solar tab).
  _computeAvailable(carW) {
    const gridW = this._inputValue('grid_w') || 0;
    const toleranceW = parseInt(this._setting('solar_grid_tolerance_w', 0), 10) || 0;
    const countDischarge = this._countDischarge();
    let dischargeW = 0;
    let batteryTermActive = false;
    let chargeW = 0;
    if (countDischarge && this._inputAge('battery_power_w') <= STALE_INPUT_MS) {
      batteryTermActive = true;
      const battW = this._inputValue('battery_power_w') || 0; // +charging / −discharging
      if (battW < -BATTERY_DISCHARGE_DEADBAND_W) dischargeW = -battW;
      if (battW > BATTERY_DISCHARGE_DEADBAND_W) chargeW = battW;
    }
    return {
      availableW: carW - gridW - dischargeW + toleranceW,
      gridW,
      dischargeW,
      chargeW,
      toleranceW,
      batteryTermActive,
    };
  }

  async _solarTick() {
    // Same shared guard as the off-peak tick — see the comment there
    if (this._tickBusy || this.device._startInFlight) return;
    this._tickBusy = true;
    try {
      return await this._solarTickInner();
    } finally {
      this._tickBusy = false;
    }
  }

  // "Configured but starving" detector: solar is enabled, a car is
  // connected, and the data it needs has NEVER arrived (forgotten or
  // broken update flows, or a minimum-battery rule with no battery
  // level card wired). The engine is already failing SAFELY — this is
  // about failing AUDIBLY: one Timeline note per plug-in, so a user who
  // honestly believes solar charging is working finds out today, not in
  // next month's electricity bill. Grace period so a normal flow that
  // simply hasn't ticked yet doesn't false-alarm.
  _checkStarvation() {
    const d = this.device;
    if (this._setting('solar_enabled', false) !== true) return;
    const state = d.getCapabilityValue('evcharger_charging_state');
    if (state !== 'connected' && state !== 'charging') return;
    const conn = d._connectionStart || 'no-marker';
    if (this._starvationNotified === conn) return;
    const connectedForMs = d._connectionStart ? (Date.now() - d._connectionStart) : 0;
    if (connectedForMs < 10 * 60 * 1000) return; // 10 min grace after plug-in
    // App-uptime grace: feeder timestamps live in memory only, so right
    // after a restart everything reads "never arrived" even when the
    // flows are healthy — and since the plug-in time now survives
    // restarts (it used to reset, masking this), the plug-in grace above
    // no longer covers the boot window. Give the flows 5 minutes of
    // uptime to tick before declaring starvation.
    if (Date.now() - this._engineStartedAt < 5 * 60 * 1000) return;
    const gridAge = this._inputAge('grid_w');
    const prodAge = this._inputAge('production_w');
    const minSoc = this._minSoc();
    const socAge = this._inputAge('battery_soc');
    if (gridAge === Infinity || prodAge === Infinity) {
      this._starvationNotified = conn;
      d._postNotification('🤔', 'Solar data missing',
        'Automatic solar charging is on, but no solar data has arrived since the car was plugged in — check your "Update solar…" flows. Details on the Solar tab.').catch(() => {});
    } else if (minSoc > 0 && socAge === Infinity) {
      this._starvationNotified = conn;
      d._postNotification('🤔', 'Battery level missing',
        `Solar charging is waiting for your home battery level (minimum ${minSoc}%), but the "Update battery SOC" flow card has never run — wire it, or set the minimum to 0. Details on the Solar tab.`).catch(() => {});
    }
  }

  async _solarTickInner() {
    const d = this.device;
    this._checkStarvation();
    // Car-phase learning is OWNER-AGNOSTIC and runs before the
    // solar-enabled gate: any active session teaches (manual, off-peak,
    // solar — an off-peak 16A night run is the best measurement there
    // is), so the next sunny morning already knows the car.
    if (d.getCapabilityValue('evcharger_charging_state') === 'charging' && !d._autoStartBlocked) {
      this._updateEffPhases(d.getCapabilityValue('measure_power') || 0, d._txnAmps);
    }
    if (this._setting('solar_enabled', false) !== true) {
      this._resetSolarTimers();
      return;
    }
    if (d.chargerOffline) return;

    const engineCharging = d.sessionOwner === 'solar' && d._txnId && !d._autoStartBlocked;
    const enginePaused = d.sessionOwner === 'solar' && d.stitchedSession && d.stitchedSession.paused;

    // ── Data freshness gate: any required input stale > 5 min suspends
    // the engine SAFELY — an actively charging engine session gets masked-
    // paused (we can no longer prove it's running on surplus), a paused
    // one stays paused, and no new session starts.
    if (!this._inputsFresh()) {
      if (!this._staleSuspended) {
        this._staleSuspended = true;
        d.log('Solar paused itself: energy data is older than 5 minutes — check the update flows');
      }
      this._resetSolarTimers();
      if (engineCharging) {
        try {
          await d.pauseCharging('solar-stale');
        } catch (err) {
          d.log(`Solar stale-data pause failed: ${err.message}`);
        }
      }
      return;
    }
    if (this._staleSuspended) {
      this._staleSuspended = false;
      d.log('Solar resumed: energy data is fresh again');
    }

    // ── Battery-first gate: below the minimum SOC, the house battery has
    // priority — treated as "no surplus available" so the same grace/stop
    // paths apply. (Belt-and-braces: FusionSolar already blocks battery→car
    // outside the deliberate morning window, which is EMMA territory.)
    const minSoc = this._minSoc();
    const soc = this._inputValue('battery_soc');
    const socOk = minSoc <= 0 || (soc !== null && soc >= minSoc);

    // ── Available surplus for the car ─────────────────────────────────
    const carW = engineCharging ? (d.getCapabilityValue('measure_power') || 0) : 0;
    const surplus = this._computeAvailable(carW);
    const availableW = socOk ? surplus.availableW : -1;

    const startSustainMs = (parseInt(this._setting('solar_start_sustain_s', 180), 10) || 180) * 1000;
    const stepHoldMs = (parseInt(this._setting('solar_step_hold_s', 120), 10) || 120) * 1000;
    const stopGraceMs = (parseInt(this._setting('solar_stop_grace_s', 300), 10) || 300) * 1000;

    const now = Date.now();

    // ── Engine session actively charging: track the ladder ────────────
    if (engineCharging) {
      this._surplusSince = null;
      // Learn how many phases THIS car draws on, then price every step —
      // and the pause floor — for this car rather than the physical worst
      // case. A 2-phase hybrid's 12A step costs 5.5 kW, not 8.3 kW.
      this._updateEffPhases(d.getCapabilityValue('measure_power') || 0, d._txnAmps);
      const bs = this._stepWithBootstrap(availableW, surplus.chargeW, socOk);
      this._bootstrapActive = bs.bootstrapped;
      const step = bs.step;
      if (!step) {
        // Surplus gone (clouds, kettle, battery gate): masked pause after
        // the stop grace, so brief dips don't kill the session. Unless the
        // meter says we're EXPORTING — then the math is wrong (self-capping
        // car), not the sun, and the session stays.
        this._pendingStepAmps = null;
        this._pendingStepSince = null;
        const gridNowW = this._inputValue('grid_w');
        if (gridNowW !== null && gridNowW <= -200) {
          this._belowFloorSince = null;
          return;
        }
        if (!this._belowFloorSince) this._belowFloorSince = now;
        if (now - this._belowFloorSince >= stopGraceMs) {
          this._belowFloorSince = null;
          d.log(`Solar: surplus below this car's ${this._effLadderWatts()[0].watts}W floor for ${Math.round(stopGraceMs / 1000)}s — masked pause`);
          try {
            await d.pauseCharging('solar');
          } catch (err) {
            d.log(`Solar pause failed: ${err.message}`);
          }
        }
        return;
      }
      this._belowFloorSince = null;

      const currentAmps = d._txnAmps;

      // ── Anti-thrash guardrails (grid-truth): the meter outranks the
      // rung math. Self-capping cars make theoretical prices pessimistic.
      //   · exporting ≥ 200W  → never step down, never starve-pause
      //   · importing > 200W  → 60s sustained → shed rungs to fit, or
      //     masked-pause if even the 6A floor can't fit
      //   · stepping UP needs rung price + 250W margin to arm the
      //     hold, plus a 5-min cooldown after any down-step
      const EXPORT_GUARD_W = 200;
      const IMPORT_ACT_W = 200;
      const UP_MARGIN_W = 250;
      const IMPORT_HOLD_MS = 60 * 1000;
      const FLIP_COOLDOWN_MS = 5 * 60 * 1000;

      const gridW = this._inputValue('grid_w');
      const exporting = gridW !== null && gridW <= -EXPORT_GUARD_W;
      const importing = gridW !== null && gridW >= IMPORT_ACT_W;
      if (importing) { if (!this._importSince) this._importSince = now; } else { this._importSince = null; }

      // Import sustained: act now — one decisive re-fit, not a slow walk.
      if (importing && (now - this._importSince) >= IMPORT_HOLD_MS) {
        this._importSince = null;
        this._pendingStepAmps = null;
        this._pendingStepSince = null;
        const ladder = this._effLadderWatts();
        const carWNow = d.getCapabilityValue('measure_power') || 0;
        const affordableW = carWNow - gridW - 100;
        let fit = null;
        for (const rung of ladder) { if (rung.watts <= affordableW) fit = rung; }
        if (fit && fit.amps < currentAmps) {
          this._lastDownStepAt = now;
          d.log(`Solar: importing ${gridW}W for 60s — stepping ${currentAmps}A → ${fit.amps}A to shed it`);
          try {
            await d.setChargingLimit(fit.amps, undefined, 'solar');
          } catch (err) {
            d.log(`Solar step failed: ${err.message}`);
          }
        } else if (!fit) {
          this._lastDownStepAt = now;
          d.log(`Solar: importing ${gridW}W for 60s and even the ${ladder[0].watts}W floor doesn't fit — masked pause`);
          try {
            await d.pauseCharging('solar');
          } catch (err) {
            d.log(`Solar pause failed: ${err.message}`);
          }
        }
        return;
      }

      if (step.amps > currentAmps) {
        // Up-step: the +250W margin gates ARMING the hold. A 5-min cooldown
        // after any down-step prevents flip-flopping on oscillating surplus.
        const rung = this._effLadderWatts().find((r) => r.amps === step.amps);
        const okCooldown = !this._lastDownStepAt || (now - this._lastDownStepAt) >= FLIP_COOLDOWN_MS;
        if (!okCooldown) {
          this._pendingStepAmps = null;
          this._pendingStepSince = null;
          return;
        }
        if (this._pendingStepAmps !== step.amps) {
          const okMargin = rung ? (availableW >= rung.watts + UP_MARGIN_W) : false;
          if (!okMargin) return; // not enough headroom to arm — try again next tick
          this._pendingStepAmps = step.amps;
          this._pendingStepSince = now;
          d.log(`Solar: surplus can pay for ${step.amps}A (now ${currentAmps}A) — confirming for ${Math.round(stepHoldMs / 1000)}s before stepping`);
        } else if (now - this._pendingStepSince >= stepHoldMs) {
          this._pendingStepAmps = null;
          this._pendingStepSince = null;
          d.log(`Solar: stepping ${currentAmps}A → ${step.amps}A — the surplus held long enough`);
          try {
            await d.setChargingLimit(step.amps, undefined, 'solar');
          } catch (err) {
            d.log(`Solar step failed: ${err.message}`);
          }
        }
      } else if (step.amps < currentAmps) {
        if (exporting) {
          // Export guard: the meter says the current level is paid for.
          this._pendingStepAmps = null;
          this._pendingStepSince = null;
          return;
        }
        // Dead band (no meaningful export or import): theory-based down-step
        // with the normal hold, as before.
        if (this._pendingStepAmps !== step.amps) {
          this._pendingStepAmps = step.amps;
          this._pendingStepSince = now;
          d.log(`Solar: surplus can pay for ${step.amps}A (now ${currentAmps}A) — confirming for ${Math.round(stepHoldMs / 1000)}s before stepping`);
        } else if (now - this._pendingStepSince >= stepHoldMs) {
          this._pendingStepAmps = null;
          this._pendingStepSince = null;
          this._lastDownStepAt = now;
          d.log(`Solar: stepping ${currentAmps}A → ${step.amps}A — the surplus held long enough`);
          try {
            await d.setChargingLimit(step.amps, undefined, 'solar');
          } catch (err) {
            d.log(`Solar step failed: ${err.message}`);
          }
        }
      } else {
        this._pendingStepAmps = null;
        this._pendingStepSince = null;
      }
      return;
    }

    // ── Engine session masked-paused (cloud gap): stitched resume when
    // sustained surplus returns ────────────────────────────────────────
    // Same plug-in, same car: the learned phase count survives the pause,
    // so a hybrid resumes at the step its real draw justifies
    if (enginePaused) {
      const bs = this._stepWithBootstrap(availableW, surplus.chargeW, socOk);
      this._bootstrapActive = bs.bootstrapped;
      const step = bs.step;
      this._pendingStepAmps = null;
      this._belowFloorSince = null;
      if (step) {
        if (!this._surplusSince) this._surplusSince = now;
        if (now - this._surplusSince >= startSustainMs) {
          this._surplusSince = null;
          d.log(`Solar: the surplus is back and held — resuming the same session at ${step.amps}A`);
          d._txnAmps = step.amps;
          d.stitchedSession.resumeAmps = step.amps;
          await d._persistStitched();
          try {
            await d.resumeCharging('engine');
          } catch (err) {
            d.log(`Solar resume failed: ${err.message}`);
          }
        }
      } else {
        this._surplusSince = null;
      }
      return;
    }

    // ── Someone else's session or pause: sovereign, leave it alone ─────
    if (d._txnId || d.stitchedSession) {
      if (d.sessionOwner !== 'solar') {
        this._resetSolarTimers();
        return;
      }
      // owner 'solar' with a blocked transaction can't happen via engine
      // starts (startCharging raises the block) — reset defensively.
      this._resetSolarTimers();
      return;
    }

    // ── No session at all: sustained surplus starts one ────────────────
    // Priced for the REMEMBERED car when we have one (learned from any
    // previous session — manual, off-peak, or solar), physical phases
    // otherwise. This is what lets a 4.0 kW export start a 2-phase
    // hybrid (2.8 kW floor) that a 4.14 kW tri-phase floor refused.
    const bs2 = this._stepWithBootstrap(availableW, surplus.chargeW, socOk);
    this._bootstrapActive = bs2.bootstrapped;
    const step = bs2.step;
    if (this._solarSuppressedConnection
      && this._solarSuppressedConnection === (d._connectionStart || 'no-connection-marker')) {
      return; // user stopped a solar session on this plug-in — stay away until re-plug
    }
    if (step && this._canStartSession()) {
      if (!this._surplusSince) {
        this._surplusSince = now;
        d.log(`Solar: surplus ${Math.round(availableW)}W covers the floor — verifying it sustains for ${Math.round(startSustainMs / 1000)}s`);
      }
      if (now - this._surplusSince >= startSustainMs) {
        this._surplusSince = null;
        d.log(`Solar: sustained surplus ${Math.round(availableW)}W — starting at ${step.amps}A`);
        try {
          await d.startCharging(step.amps, undefined, 'solar');
        } catch (err) {
          d.log(`Solar start failed: ${err.message}`);
        }
      }
    } else {
      this._surplusSince = null;
    }
  }

  // Debug snapshot for the settings page / logs
  getDebugState() {
    const fmt = (k) => {
      const inp = this.inputs[k];
      return inp ? `${inp.value} (${Math.round((Date.now() - inp.at) / 1000)}s ago)` : 'never fed';
    };
    return {
      solarEnabled: this._setting('solar_enabled', false) === true,
      offpeakEnabled: this._setting('offpeak_enabled', false) === true,
      inputs: {
        production_w: fmt('production_w'),
        grid_w: fmt('grid_w'),
        battery_soc: fmt('battery_soc'),
        battery_power_w: fmt('battery_power_w'),
      },
      inputsFresh: this._inputsFresh(),
      sessionOwner: this.device.sessionOwner || null,
      windowOpen: this._computeWindow(new Date()).open,
    };
  }

  // ─── Rich status for the settings page's Solar tab ─────────────────
  // Read-only mirror of exactly what the ticks see: same inputs, same
  // surplus math, same window computation — so what the tab shows is what
  // the engine acts on, not a parallel reimplementation that can drift.

  getSolarStatus() {
    const d = this.device;
    const now = Date.now();

    const inputSnap = (k) => {
      const inp = this.inputs[k];
      if (!inp) return { value: null, ageS: null, stale: true };
      const ageS = Math.round((now - inp.at) / 1000);
      return { value: inp.value, ageS, stale: (now - inp.at) > STALE_INPUT_MS };
    };

    const solarEnabled = this._setting('solar_enabled', false) === true;
    const minSoc = this._minSoc();
    const toleranceW = parseInt(this._setting('solar_grid_tolerance_w', 0), 10) || 0;
    const soc = this._inputValue('battery_soc');
    const socOk = minSoc <= 0 || (soc !== null && soc >= minSoc);
    const fresh = this._inputsFresh();

    const engineCharging = d.sessionOwner === 'solar' && d._txnId && !d._autoStartBlocked;
    const enginePaused = d.sessionOwner === 'solar' && !!(d.stitchedSession && d.stitchedSession.paused);

    // Same surplus math as _solarTick — literally the same function,
    // including the per-car ladder pricing
    const carW = engineCharging ? (d.getCapabilityValue('measure_power') || 0) : 0;
    const surplus = this._computeAvailable(carW);
    const availableW = (this._inputValue('grid_w') === null) ? null : surplus.availableW;
    const step = (availableW !== null && socOk)
      ? (engineCharging || enginePaused ? this._effStepFor(availableW) : this._stepFor(availableW))
      : null;

    // Human-readable engine phase
    let engineState = 'inactive';
    if (solarEnabled) {
      if (!fresh) engineState = 'suspended_stale';
      else if (engineCharging) {
        engineState = this._pendingStepAmps ? 'charging_step_pending'
          : this._belowFloorSince ? 'charging_grace' : 'charging';
      } else if (enginePaused) {
        engineState = this._surplusSince ? 'paused_sustaining' : 'paused_waiting';
      } else if (d._txnId || d.stitchedSession) engineState = 'other_session';
      else if (this._surplusSince) engineState = 'sustaining';
      else if (step && d.getCapabilityValue('evcharger_charging_state') !== 'connected') {
        // Surplus covers a step but there is nothing to charge
        engineState = 'waiting_car';
      } else if (step && this._solarSuppressedConnection
        && this._solarSuppressedConnection === (d._connectionStart || 'no-connection-marker')) {
        engineState = 'suppressed';
      } else engineState = 'waiting_surplus';
    }

    // Timer progress (seconds elapsed of the relevant countdown, if any)
    const prog = (since) => since ? Math.round((now - since) / 1000) : null;

    // Off-peak: resolved windows + next boundary (scan at minute
    // granularity; the window logic itself is the source of truth)
    const offpeakEnabled = this._setting('offpeak_enabled', false) === true;
    const winNow = this._computeWindow(new Date());
    let nextChangeAt = null;
    if (offpeakEnabled) {
      const probe = new Date();
      probe.setSeconds(0, 0);
      for (let i = 1; i <= 48 * 60; i++) {
        probe.setMinutes(probe.getMinutes() + 1);
        if (this._computeWindow(probe).open !== winNow.open) {
          nextChangeAt = probe.getTime();
          break;
        }
      }
    }

    return {
      sessionOwner: d.sessionOwner || null,
      solar: {
        enabled: solarEnabled,
        engineState,
        inputs: {
          production_w: inputSnap('production_w'),
          grid_w: inputSnap('grid_w'),
          battery_soc: inputSnap('battery_soc'),
          battery_power_w: inputSnap('battery_power_w'),
        },
        inputsFresh: fresh,
        staleAfterS: Math.round(STALE_INPUT_MS / 1000),
        minBatterySoc: minSoc,
        socOk,
        gridToleranceW: toleranceW,
        availableW: availableW !== null ? Math.round(availableW) : null,
        surplusBreakdown: {
          carW: Math.round(carW),
          gridW: Math.round(surplus.gridW),
          batteryDischargeW: Math.round(surplus.dischargeW),
          batteryChargeW: Math.round(surplus.chargeW || 0),
          bootstrapActive: !!this._bootstrapActive,
          batteryTermActive: surplus.batteryTermActive,
          countDischargeEnabled: this._countDischarge(),
          hasBattery: this._hasBattery(),
          toleranceW: surplus.toleranceW,
        },
        targetStep: step, // { amps, watts } | null
        currentAmps: engineCharging ? (d._txnAmps || null) : null,
        ladder: this._effLadderWatts(),
        physicalPhases: d._devicePhases(),
        carPhases: this._carPhases(),
        carPhaseSource: this._carPhaseSource(),
        carPhasesDetected: this._carPhasesDetected(),
        timers: {
          startSustainS: parseInt(this._setting('solar_start_sustain_s', 180), 10) || 180,
          stepHoldS: parseInt(this._setting('solar_step_hold_s', 120), 10) || 120,
          stopGraceS: parseInt(this._setting('solar_stop_grace_s', 300), 10) || 300,
          surplusForS: prog(this._surplusSince),
          belowFloorForS: prog(this._belowFloorSince),
          pendingStepAmps: this._pendingStepAmps,
          pendingStepForS: prog(this._pendingStepSince),
        },
        suppressedThisPlugin: this._solarSuppressedConnection !== null
          && this._solarSuppressedConnection === (d._connectionStart || 'no-connection-marker'),
      },
      offpeak: {
        enabled: offpeakEnabled,
        amps: parseInt(this._setting('offpeak_amps', '16'), 10) || 16,
        weekday: {
          start: this._setting('offpeak_weekday_start', '22:00'),
          end: this._setting('offpeak_weekday_end', '06:00'),
        },
        weekendDiffers: this._setting('offpeak_weekend_differs', false) === true,
        weekend: {
          start: this._setting('offpeak_weekend_start', '22:00'),
          end: this._setting('offpeak_weekend_end', '06:00'),
        },
        openNow: winNow.open,
        solarFirst: this._setting('offpeak_solar_first', true) !== false,
        deferringToSolarNow: winNow.open && this._solarCouldClaim(),
        nextChangeAt,
        suppressedThisWindow: winNow.open && this._offpeakSuppressedWindowId === winNow.windowId,
      },
    };
  }
}

module.exports = SolarOffpeakEngine;
