'use strict';

// EMS simpleDevices methods. Mixed into EmsDevice.prototype; `this` is the device
// instance. Extracted from drivers/energy_management/device.js.
const {
  SIMPLE_MIN_RUN_MS, MIN_CHARGE_W, HIST, SIMPLE_STATE_KEY, SIMPLE_STATE_MAX_GAP_MS,
  SIMPLE_STATE_SAVE_MS, TRIGGER_BUDGET_MS, OVERFLOW_KEEP_W, OVERFLOW_START_W,
} = require('./constants');

// Fields the state machine reads. lastDiagKey is deliberately absent: it exists to
// suppress repeated log lines and would only cause needless writes.
const SIMPLE_STATE_FIELDS = [
  'isOn', 'startedAt', 'surplusOkSince', 'surplusBadSince',
  'powerDropStoppedAt', 'lastEmsStopAt', 'externalOn',
];

module.exports = {

  // The five maps, keyed the way they are stored. Kept in one place so persisting and
  // restoring cannot disagree about which maps exist.
  _simpleStateMaps() {
    return {
      heat_pump:    this._heatPumpStates,
      boiler:       this._boilerStates,
      pool:         this._poolStates,
      dehumidifier: this._dehumidifierStates,
      aircon:       this._airconStates,
    };
  },

  // Called once from onInit, before the tick loop starts.
  //
  // These maps live in memory only, so a restart used to erase every timer in them. The
  // visible cost was a stop-grace that never elapsed: a device with a 30-minute grace
  // went back to zero on each restart and stayed on indefinitely across a day of
  // deploys. Timers are absolute timestamps, so restoring them is enough.
  _restoreSimpleStates() {
    let saved;
    try { saved = this.homey.settings.get(SIMPLE_STATE_KEY); } catch (_) { return; }
    if (!saved || !saved.maps) return;

    const now = Date.now();
    const gap = now - (Number(saved.savedAt) || 0);
    if (!(gap >= 0) || gap > SIMPLE_STATE_MAX_GAP_MS) {
      this.log(`[EMS] simple-device state discarded — ${Math.round(gap / 60_000)} min old (max ${SIMPLE_STATE_MAX_GAP_MS / 60_000})`);
      return;
    }

    let restored = 0;
    for (const [key, map] of Object.entries(this._simpleStateMaps())) {
      const stored = saved.maps[key];
      if (!stored || !map) continue;
      for (const [id, st] of Object.entries(stored)) {
        if (!st || typeof st !== 'object') continue;
        const clean = {};
        for (const f of SIMPLE_STATE_FIELDS) {
          const v = st[f];
          // A timestamp from the future means the clock moved, not that something is
          // scheduled — drop it rather than let a timer never expire.
          if (typeof v === 'number') clean[f] = v > now ? null : v;
          else clean[f] = v === undefined ? null : v;
        }
        map.set(id, clean);
        restored++;
      }
    }
    if (restored) this.log(`[EMS] simple-device state restored — ${restored} device(s), ${Math.round(gap / 1000)}s gap`);
  },

  /**
   * Called at the end of every tick, and once more from onUninit.
   *
   * Writes when the content changed, when SIMPLE_STATE_SAVE_MS has passed since the last
   * write, or when forced (shutdown). A steady state therefore costs one JSON.stringify per
   * tick and a settings write every five minutes.
   *
   * The periodic write is not about the content — that is identical — but about `savedAt`,
   * which _restoreSimpleStates reads as "how long has this state been unattended". Writing
   * only on change made that timestamp report the age of the last decision instead, and a
   * house that had been quiet for eleven minutes lost its timers to a deploy that took
   * eighteen seconds. Same reasoning, same shape as _saveChargerStates.
   *
   * @returns {boolean} true when something was written
   */
  _saveSimpleStates(force = false, now = Date.now()) {
    const maps = {};
    for (const [key, map] of Object.entries(this._simpleStateMaps())) {
      if (!map || !map.size) continue;
      const out = {};
      for (const [id, st] of map.entries()) {
        const clean = {};
        for (const f of SIMPLE_STATE_FIELDS) if (st[f] !== undefined) clean[f] = st[f];
        out[id] = clean;
      }
      maps[key] = out;
    }
    const body    = JSON.stringify(maps);
    const changed = body !== this._lastSimpleStateJson;
    const overdue = !this._lastSimpleStateSaveAt
      || (now - this._lastSimpleStateSaveAt) >= SIMPLE_STATE_SAVE_MS;
    if (!force && !changed && !overdue) return false;

    this._lastSimpleStateJson   = body;
    this._lastSimpleStateSaveAt = now;
    try {
      this.homey.settings.set(SIMPLE_STATE_KEY, { savedAt: now, maps });
    } catch (e) {
      this.log(`[EMS] simple-device state save failed: ${e.message}`);
      return false;
    }
    return true;
  },

  async _getSimpleDevices(devicesKey, cfg) {
    const cfgs = cfg[devicesKey] || [];
    return Promise.all(cfgs.map(async (c) => {
      // State source: 'onoff' (default) | 'power' | 'ems'.
      // Back-compat: the old boolean state_from_power === true meant 'power'.
      const stateSource = c.state_source || (c.state_from_power === true ? 'power' : 'onoff');
      const [powerW, onoff] = await Promise.all([
        c.cap_power ? this._cap(c.id, c.cap_power) : Promise.resolve(null),
        // Only the onoff source needs the onoff read
        stateSource === 'onoff' ? this._cap(c.id, 'onoff') : Promise.resolve(null),
      ]);
      const minPowerW = Number(c.min_power_w) || 0;
      // actualOn: the device's real on/off state as the EMS sees it.
      //   - onoff : the device's onoff capability (null → unknown, drift skipped)
      //   - power : power ≥ threshold (for always-on plugs where start/stop toggle
      //             an internal load). Threshold = min_power_w if set, else 50 W.
      //   - ems   : null → the EMS trusts its own bookkeeping and never adopts an
      //             external state (for devices nudged via setpoints/hysteresis,
      //             where neither onoff nor power reflects the EMS command).
      let actualOn;
      if (stateSource === 'power') {
        const thr = minPowerW > 0 ? minPowerW : 50;
        actualOn  = powerW != null ? (powerW >= thr) : null;
      } else if (stateSource === 'ems') {
        actualOn  = null;
      } else {
        actualOn  = typeof onoff === 'boolean' ? onoff : null;
      }
      return {
        id:                  c.id,
        name:                c.name || c.id.slice(0, 8),
        powerW,
        onoff,
        actualOn,
        stateSource,
        minSurplusW:         Number(c.min_surplus_w)         || 2000,
        minPowerW,
        startSustainMs:      Number(c.start_sustain_s        || 60) * 1000,
        stopGraceMs:         Number(c.stop_grace_s           || 60) * 1000,
        // After an EMS start, how long to wait for a power-based device to draw
        // power before a below-threshold reading counts as an external OFF. Slow
        // ramp-up devices (heat pumps) need more than a few ticks. Default 120 s.
        startupGraceMs:      Math.max(0, Number(c.startup_grace_s ?? 120)) * 1000,
        maxRunMs:            Number(c.max_run_min            || 0)  * 60_000,
        restartCooldownMs:   Number(c.restart_cooldown_min   || 5)  * 60_000,
        // Per-device "EMS controls this device" toggle — undefined/missing means
        // enabled (backward-compatible default). See lib/ems/widget.js.
        enabled:             c.enabled !== false,
      };
    }));
  },

  async _simpleDeviceSetOn(id, name, on, stateMap, startCard, stopCard, tokenName) {
    const st = stateMap.get(id); // guaranteed initialized by _evaluateSimpleDevices
    if (!this._warmupDone) { return; } // first tick: state already initialised from actual device, no flows fired
    if (st.isOn === on) return;
    if (on) st.startedAt = Date.now();
    else { st.startedAt = null; st.lastEmsStopAt = Date.now(); }
    st.isOn = on;
    this._postNotification(`EMS: ${name} ${on ? 'gestartet' : 'gestoppt'}`);
    this._addHistoryEvent(HIST.DEVICE, on ? 'start' : 'stop', name, id);
    const card = on ? startCard : stopCard;
    this.log(`[EMS] ${tokenName} ${id}: ${on ? 'start' : 'stop'} → trigger ${card}`);
    // Bounded, for the same reason the charger triggers are (see lib/ems/timing.js). The
    // loop needs the trigger DISPATCHED, never finished — nothing here reads a result, and
    // st.isOn is already set above. What runs afterwards is the user's own flow, and a flow
    // is free to take its time: this owner's air-conditioning stop deliberately waits five
    // minutes before cutting the unit, which is a perfectly reasonable thing for it to do.
    //
    // Without the budget the EMS stood next to it for those five minutes. A 33-hour field
    // log showed five air-conditioning stops and five tick overruns, each exactly 40 s after
    // its stop — five for five, and no other device's trigger ever produced one. It is the
    // same failure that emptied the house battery in July, when a 300 s tick meant the car
    // was neither turned down nor stopped for five minutes.
    await this._settleWithin(
      this.homey.flow
        .getTriggerCard(card)
        .trigger({ [tokenName]: id }, { [tokenName]: id })
        .catch((e) => this.log(`[EMS] trigger ${card} failed: ${e.message}`)),
      TRIGGER_BUDGET_MS, `${tokenName} ${id} ${on ? 'start' : 'stop'}`);
  },

  async _evaluateSimpleDevices(battery, gridW, devices, stateMap, startCard, stopCard, tokenName, cfg) {
    if (!devices.length) return 0;

    const { batHardStop } = this._batteryZones(cfg, battery);
    const batChg     = battery.powerW !== null && battery.powerW > 0;
    // A discharging battery flattens the grid meter, and the meter is all this test had.
    // Measured case: PV 291 W, pool + dehumidifier + air conditioner running, battery
    // delivering 1557 W, meter reading −46 W. The EMS read that as export, called it
    // "solar surplus" and kept all three running while the battery quietly paid for them.
    // Taking the discharge off the top leaves the part the sun is actually carrying.
    // Consequence worth knowing: at a high SOC with a high house load, devices now run
    // less than before — the SOC ramp governs how much PV they get, and nothing hands
    // them battery charge behind its back.
    const dischargeW = battery.powerW !== null ? Math.max(0, -battery.powerW) : 0;
    const exportW    = (gridW !== null ? -gridW : 0) - dischargeW;
    // Hysteresis (same fix already applied to the EV charger overflow exception in
    // chargerControl.js): require 2×MIN_CHARGE_W export to START overflow-running but
    // only ½×MIN_CHARGE_W to CONTINUE. Without this, a device that just started under
    // the overflow exception consumes some of what was being exported — pushing
    // exportW back below the threshold on the very next tick, which hard-stops the
    // device that only just started (bypassing every grace timer, since hard-stop
    // intentionally overrides them) instead of letting it run.
    const anyRunning = Array.from(stateMap.values()).some((st) => st.isOn);
    const overflowThreshold = anyRunning ? OVERFLOW_KEEP_W : OVERFLOW_START_W;
    const batOverflow = batHardStop && batChg && exportW >= overflowThreshold;

    const now = Date.now();
    // Forward-looking solar-forecast gate: on a poor-forecast day, suppress NEW starts
    // (running devices finish normally). Same for the whole device type this tick.
    const gateBlocksStarts = this._forecastGateBlocksStarts(cfg, battery, now);
    let allocatedDeltaW = 0;
    // Track a running export budget so multiple devices of the same type share correctly:
    // when device N starts this tick, device N+1 sees reduced surplus in the same loop.
    let runningExportW = exportW;
    for (const device of devices) {
      if (!stateMap.has(device.id)) {
        // Pre-initialise from the actual device state so a restart does not re-fire
        // start flows for devices that were already running before the app restarted.
        //
        // Backdated past the min-run window on purpose. We are adopting a device that was
        // already running, not starting one, and we have no idea when it actually started.
        // Stamping it with `now` claimed it had just started, which handed every running
        // device a fresh SIMPLE_MIN_RUN_MS of unconditional runtime on every app restart —
        // surplus ignored. Visible as three devices reporting "hold-time active" half a
        // second after "[EMS] initialized". Min-run exists to stop us short-cycling a
        // device we just switched on; an adopted device has already had its run.
        //
        // Costs an adopted device up to SIMPLE_MIN_RUN_MS of its max-run budget, which
        // reads the same clock. That errs towards stopping early, which is the safe side.
        const actuallyOn = device.actualOn === true;
        stateMap.set(device.id, {
          isOn: actuallyOn,
          startedAt: actuallyOn ? Date.now() - SIMPLE_MIN_RUN_MS : null,
          surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null,
        });
      }
      const st         = stateMap.get(device.id);

      // Per-device "EMS controls this device" toggle (set via the ems-device
      // widget or Settings) — skip everything below entirely: no drift-sync
      // adoption, no start/stop commands. getEmsControllableStatus (widget.js)
      // reads device.actualOn directly for a disabled device instead of this
      // stale stateMap entry, so the widget still shows the real live state.
      if (device.enabled === false) continue;

      // ── External-control drift sync ───────────────────────────────────────
      // device.actualOn is the real device state as the EMS sees it — from the
      // onoff capability, or from measured power when "state from power" is on
      // (for always-on plugs where start/stop toggle an internal load like a
      // pool heater/filter, onoff never changes and power is the only signal).
      //
      // External OFF (EMS believes on, device is off): adopt — otherwise the
      // device is believed running forever and never restarted. The restart
      // cooldown is applied so the EMS doesn't immediately undo the manual off.
      //
      // External ON (EMS believes off, device is on): do NOT adopt. A manual
      // start is the user's decision — adopting it would put it under EMS
      // control and e.g. battery protection would stop it on the next tick,
      // then re-adopt, re-stop … every tick. Instead the device is marked
      // externally controlled and skipped until it turns off again.
      // Grace period: right after an EMS stop the device may lag a few ticks
      // before actually switching off — don't treat that as a manual start.
      if (this._warmupDone && device.actualOn !== null) {
        // Power-based state lags on ramp-up: after an EMS start the heater/pump
        // needs a few ticks before power crosses the threshold. Don't misread
        // that startup window as an external OFF and cancel our own start.
        const startGraceActive = st.startedAt && (now - st.startedAt) < device.startupGraceMs;
        if (!device.actualOn && st.isOn && !startGraceActive) {
          this.log(`[EMS] ${tokenName} ${device.id}: external OFF detected — adopting state`);
          this._addHistoryEvent(HIST.DEVICE, 'manual_off', device.name, device.id);
          // Power-based state cannot tell "the user switched the plug off" (already
          // off — no command needed) from "the load finished but the EMS-controlled
          // switch is still on" (must be turned off). Fire the stop trigger so a
          // switch the EMS had turned on is always commanded off; toggling an
          // already-off switch is a harmless no-op. On/off mode reports the switch
          // itself, so it is genuinely off already and needs no stop.
          if (device.stateSource === 'power') {
            st.lastEmsStopAt = now;
            this.log(`[EMS] ${tokenName} ${device.id}: firing stop trigger ${stopCard} (power-mode adoption — ensure switch is off)`);
            await this._settleWithin(
              this.homey.flow
                .getTriggerCard(stopCard)
                .trigger({ [tokenName]: device.id }, { [tokenName]: device.id })
                .catch((e) => this.log(`[EMS] trigger ${stopCard} failed: ${e.message}`)),
              TRIGGER_BUDGET_MS, `${tokenName} ${device.id} adoption stop`);
          }
          st.isOn      = false;
          st.startedAt = null;
          st.surplusOkSince  = null;
          st.surplusBadSince = null;
          st.powerDropStoppedAt = now;
          st.externalOn = false;
        } else if (device.actualOn && !st.isOn) {
          const lastStop        = Math.max(st.powerDropStoppedAt ?? 0, st.lastEmsStopAt ?? 0);
          // How long a device may still read "on" after an EMS stop before that reading
          // counts as the user switching it back on. This was a hard-coded 60 s, and a
          // device that executes or reports its stop more slowly than that was classified
          // "externally on — leave alone" one minute after EVERY EMS stop: the 2026-08-18
          // field log shows the air conditioner escaping EMS control this way four times
          // in one day, then running unmanaged into the evening. startupGraceMs is the
          // same physical quantity measured on the start side — the device's actuation
          // and reporting lag — and is per-device configuration the user can raise for a
          // laggy device. The old 60 s remains as the floor it always was.
          const offLagMs        = Math.max(60_000, device.startupGraceMs || 0);
          const stopGraceActive = lastStop && (now - lastStop) < offLagMs;
          if (!stopGraceActive) {
            if (!st.externalOn) {
              this.log(`[EMS] ${tokenName} ${device.id}: externally switched ON — leaving it alone (not EMS-controlled)`);
              this._addHistoryEvent(HIST.DEVICE, 'manual_on', device.name, device.id);
              st.externalOn = true;
            }
            continue; // user's device, user's rules — skip all EMS control
          }
        } else if (st.externalOn && !device.actualOn) {
          this.log(`[EMS] ${tokenName} ${device.id}: externally-controlled device turned off — back under EMS control`);
          st.externalOn = false;
          st.powerDropStoppedAt = now; // restart cooldown before EMS may start it
        }
      }
      if (st.externalOn && device.actualOn === true) continue; // still externally on

      const wasOn      = st.isOn ?? false;
      const hpPowerW   = (wasOn && device.powerW != null) ? device.powerW : 0;
      const effectiveW = runningExportW + hpPowerW;
      const surplusOk  = effectiveW >= device.minSurplusW;
      const runElapsedMs = wasOn && st.startedAt !== null ? (now - st.startedAt) : 0;
      const pastMinRun   = wasOn && runElapsedMs >= SIMPLE_MIN_RUN_MS;
      const inMaxRun     = wasOn && device.maxRunMs > 0 && runElapsedMs < device.maxRunMs;
      const maxRunDone   = wasOn && device.maxRunMs > 0 && runElapsedMs >= device.maxRunMs;
      // True only during the initial SIMPLE_MIN_RUN_MS after start, keeping a freshly-started
      // device on through a brief surplus dip so it isn't stopped seconds after starting.
      // Always false once a max-run window applies — there the max-run branch keeps it on instead.
      const inHoldTime   = wasOn && !pastMinRun && !inMaxRun;

      // ── Start-sustain / stop-grace timer maintenance ──────────────────────
      if (!wasOn) {
        // Track how long surplus has been continuously OK while device is off
        if (surplusOk) { if (!st.surplusOkSince) st.surplusOkSince = now; }
        else             st.surplusOkSince = null;
        st.surplusBadSince = null;
      } else {
        st.surplusOkSince = null; // irrelevant while running
        // Track how long surplus has been absent — only counts after min-run; reset during max-run window
        if (inMaxRun) {
          st.surplusBadSince = null; // max-run overrides stop logic
        } else if (pastMinRun) {
          if (surplusOk) st.surplusBadSince = null;
          else if (!st.surplusBadSince) st.surplusBadSince = now;
        } else {
          st.surplusBadSince = null;
        }
      }

      const restartOk     = !device.restartCooldownMs || !st.powerDropStoppedAt || (now - st.powerDropStoppedAt) >= device.restartCooldownMs;
      // Under the hard-stop overflow exception a start has to leave the continue threshold
      // behind it, or it revokes its own permission: the loop books minSurplusW against the
      // export the moment a device starts, and the next tick then finds too little left and
      // hard-stops what it just switched on. The same reserve the charger holds back.
      const overflowHeadroomOk = !batOverflow
                            || effectiveW >= device.minSurplusW + OVERFLOW_KEEP_W;
      const startOk       = !wasOn && surplusOk && restartOk && overflowHeadroomOk
                            && st.surplusOkSince !== null
                            && (now - st.surplusOkSince) >= device.startSustainMs;
      const inGracePeriod = wasOn && pastMinRun && !surplusOk
                            && st.surplusBadSince !== null
                            && (now - st.surplusBadSince) < device.stopGraceMs;

      // ── Battery protection hierarchy ──────────────────────────────────────
      //   hard stop (no overflow) → off regardless of grace / max-run / hold time
      //   reserve zone, device needs more than budget → off
      //   inMaxRun → keep on (overrides surplus shortage)
      //   otherwise → surplus / timer logic
      let wantOn;
      if (batHardStop && !batOverflow) {
        wantOn = false;
      } else if (inMaxRun) {
        wantOn = true; // max-run window: ignore surplus drop
      } else {
        // The forecast gate suppresses STARTS only; a running device still finishes via
        // hold-time / surplus / grace.
        wantOn = (startOk && !gateBlocksStarts) || inHoldTime || (wasOn && (surplusOk || inGracePeriod));
      }

      // ── Max-run expired → force stop ──────────────────────────────────────
      if (maxRunDone) {
        wantOn = false;
        st.powerDropStoppedAt = now;
        this.log(`[EMS] ${tokenName} ${device.id}: max run time reached (${device.maxRunMs / 60_000} min) → stop`);
      }

      // ── Diagnostic logging (only when the phase changes — avoids per-tick spam) ─
      let diagKey = null, diagMsg = null;
      if (inMaxRun) {
        diagKey = 'maxrun';   diagMsg = `max-run active (limit ${device.maxRunMs / 60000} min)`;
      } else if (inHoldTime) {
        diagKey = 'hold';     diagMsg = `hold-time active (min-run ${SIMPLE_MIN_RUN_MS / 1000}s)`;
      } else if (!wasOn && gateBlocksStarts) {
        diagKey = 'fcgate';   diagMsg = 'solar-forecast gate — holding start (low forecast)';
      } else if (!wasOn && surplusOk && !restartOk) {
        diagKey = 'cooldown'; diagMsg = `restart-cooldown active (${device.restartCooldownMs / 1000}s)`;
      } else if (!wasOn && surplusOk && !startOk && device.startSustainMs > 0 && st.surplusOkSince) {
        diagKey = 'sustain';  diagMsg = `start-sustain pending (${device.startSustainMs / 1000}s)`;
      } else if (inGracePeriod) {
        diagKey = 'grace';    diagMsg = `stop-grace active (${device.stopGraceMs / 1000}s)`;
      }
      if (diagKey !== st.lastDiagKey) {
        if (diagMsg) this.log(`[EMS] ${tokenName} ${device.id}: ${diagMsg}`);
        st.lastDiagKey = diagKey;
      }

      // ── Power-drop: device finished its cycle (skip when battery protection already stopped it) ───
      // Only active when minPowerW > 0 (user-configured). minSurplusW is start-only; minPowerW is the
      // running threshold (e.g. pool heater done → drops to filter-only draw below minPowerW → stop).
      if (!inMaxRun && !batHardStop && wasOn && pastMinRun && device.powerW !== null && device.minPowerW > 0 && device.powerW < device.minPowerW) {
        wantOn = false;
        st.powerDropStoppedAt = now;
        this.log(`[EMS] ${tokenName} ${device.id}: power dropped to ${device.powerW}W < ${device.minPowerW}W (minPowerW) → stop (restart cooldown ${device.restartCooldownMs / 60_000} min)`);
      }

      // ── Whole-house grid-import ceiling (load shedding) ────────────────────
      // Unlike EV chargers, these devices are on/off only — no amp ladder to gracefully
      // reduce — so a start that would exceed cfg.grid_import_limit_kw is simply denied
      // (mirrors the battery force-charge check in device.js _checkBatteryPriceControl).
      // Matters most in the orange zone / overflow-exception paths above, where "surplus"
      // can be partly virtual (borrowed orange budget, or export that a just-started
      // device itself will consume) rather than guaranteed real export. Only gates NEW
      // starts — a device already running is left alone to avoid short-cycling it.
      if (!wasOn && wantOn && !this._gridImportClaimFixed(cfg, device.minSurplusW)) {
        wantOn = false;
        this.log(`[EMS] ${tokenName} ${device.id}: start denied — grid import ceiling (${cfg.grid_import_limit_kw}kW) has no headroom`);
      }

      await this._simpleDeviceSetOn(device.id, device.name, wantOn, stateMap, startCard, stopCard, tokenName);
      // Device just switched on this tick: its consumption isn't in gridW yet.
      // Use minSurplusW as a proxy (actual draw unknown until next tick) so the next device
      // in this priority loop sees a reduced surplus budget.
      if (!wasOn && wantOn) {
        allocatedDeltaW += device.minSurplusW;
        runningExportW  -= device.minSurplusW;
      }
    }
    return allocatedDeltaW;
  },

  // Note: the former _evaluateHeatPumps/_evaluateBoilers/_evaluatePool/_evaluateDehumidifier
  // wrappers were replaced by a dispatch table in device.js _tickBody (calls
  // _evaluateSimpleDevices directly with per-type flow-card / config ids).

};
