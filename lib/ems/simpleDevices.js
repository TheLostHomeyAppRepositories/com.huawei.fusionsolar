'use strict';

// EMS simpleDevices methods. Mixed into EmsDevice.prototype; `this` is the device
// instance. Extracted from drivers/energy_management/device.js.
const { SIMPLE_MIN_RUN_MS, MIN_CHARGE_W, HIST } = require('./constants');

module.exports = {

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
    await this.homey.flow
      .getTriggerCard(card)
      .trigger({ [tokenName]: id }, { [tokenName]: id })
      .catch((e) => this.log(`[EMS] trigger ${card} failed: ${e.message}`));
  },

  async _evaluateSimpleDevices(battery, gridW, devices, stateMap, startCard, stopCard, tokenName, cfgControlKey, cfg) {
    if (!devices.length) return 0;
    if (cfg[cfgControlKey] === false) return 0;

    const { batHardStop } = this._batteryZones(cfg, battery);
    const batChg     = battery.powerW !== null && battery.powerW > 0;
    const exportW     = gridW !== null ? -gridW : 0;
    const batOverflow = batHardStop && batChg && exportW >= MIN_CHARGE_W;

    const now = Date.now();
    let allocatedDeltaW = 0;
    // Track a running export budget so multiple devices of the same type share correctly:
    // when device N starts this tick, device N+1 sees reduced surplus in the same loop.
    let runningExportW = exportW;
    for (const device of devices) {
      if (!stateMap.has(device.id)) {
        // Pre-initialise from the actual device state so a restart does not re-fire
        // start flows for devices that were already running before the app restarted.
        const actuallyOn = device.actualOn === true;
        stateMap.set(device.id, { isOn: actuallyOn, startedAt: actuallyOn ? Date.now() : null, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null });
      }
      const st         = stateMap.get(device.id);

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
            await this.homey.flow
              .getTriggerCard(stopCard)
              .trigger({ [tokenName]: device.id }, { [tokenName]: device.id })
              .catch((e) => this.log(`[EMS] trigger ${stopCard} failed: ${e.message}`));
          }
          st.isOn      = false;
          st.startedAt = null;
          st.surplusOkSince  = null;
          st.surplusBadSince = null;
          st.powerDropStoppedAt = now;
          st.externalOn = false;
        } else if (device.actualOn && !st.isOn) {
          const lastStop        = Math.max(st.powerDropStoppedAt ?? 0, st.lastEmsStopAt ?? 0);
          const stopGraceActive = lastStop && (now - lastStop) < 60_000;
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
      const startOk       = !wasOn && surplusOk && restartOk
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
        wantOn = startOk || inHoldTime || (wasOn && (surplusOk || inGracePeriod));
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
