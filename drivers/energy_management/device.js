'use strict';

const { Device }    = require('homey');
const HomeyLocalApi = require('../../lib/homey-local-api');

const TICK_MS                  = 30_000;
const STEP_HOLD_MS             = 30_000;
const IMPORT_HOLD_MS           = 60_000;
const FLIP_COOLDOWN_MS         = 5 * 60_000;
const PHASE_SWITCH_COOLDOWN_MS = 10 * 60_000;
const IMPORT_ACT_W             = 200;
const UP_MARGIN_W              = 250;
const MIN_3PH_W                = 6 * 3 * 230;      // 4140 W — minimum viable 3-phase load
const AMPS_LADDER              = [6, 8, 10, 12, 14, 16, 20, 25, 32];
const MIN_CHARGE_W             = AMPS_LADDER[0] * 230; // 1380 W — single-phase minimum

class EmsDevice extends Device {

  async onInit() {
    this._chargerStates  = new Map(); // deviceId → per-charger anti-thrash state
    this._heatPumpStates = new Map(); // deviceId → { isOn: null | boolean }
    this._importSince    = null;
    this._tickTimer      = null;

    this._api = new HomeyLocalApi({
      homey:  this.homey,
      apiKey: this.getSetting('homey_api_key') || '',
    });

    await this._ensureCapabilities();
    await this._migrateConfig(); // run once on startup, writes back if format changed

    this.registerCapabilityListener('onoff',           (v) => this._onEnabledChanged(v));
    this.registerCapabilityListener('offpeak_enabled', () => this._tick().catch(() => {}));
    this.registerCapabilityListener('charge_now',      () => this._tick().catch(() => {}));

    this._startTick();
    this.log('[EMS] initialized');
  }

  async onDeleted() { this._stopTick(); }
  async onUninit()  { this._stopTick(); }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('homey_api_key')) {
      this._api.setApiKey(newSettings.homey_api_key || '');
    }
    this._stopTick();
    this._startTick();
  }

  onConfigChanged() {
    this._stopTick();
    this._startTick();
  }

  _onEnabledChanged(enabled) {
    if (!enabled) {
      this._set('ems_mode', 'disabled');
      this._set('ems_status_text', 'EMS disabled');
    } else {
      this._tick().catch(() => {});
    }
  }

  // ─── Config ───────────────────────────────────────────────────────────────

  _getConfig() {
    return this.homey.settings.get('ems_config') || {};
  }

  /** Runs once at startup: converts legacy field names and writes the result back. */
  async _migrateConfig() {
    const cfg     = this.homey.settings.get('ems_config') || {};
    let   changed = false;

    if (!cfg.chargers && cfg.charger_device_id) {
      cfg.chargers = [{ id: cfg.charger_device_id, max_amps: parseInt(cfg.ev_max_amps) || 16 }];
      changed = true;
    }

    if (!cfg.inverter_devices) {
      const ids = (cfg.grid_devices || []).map((d) => ({ id: d.id, cap_power: d.cap_power }));
      if (!ids.length) {
        const rawIds = cfg.grid_device_ids || (cfg.grid_device_id ? [cfg.grid_device_id] : []);
        const cap    = cfg.grid_capability || 'measure_power.grid_active_power';
        rawIds.forEach((id) => ids.push({ id, cap_power: cap }));
      }
      cfg.inverter_devices = ids;
      changed = true;
    }
    if (!cfg.meter_devices) { cfg.meter_devices = []; changed = true; }

    if (!cfg.battery_devices) {
      const ids = cfg.battery_device_ids || (cfg.battery_device_id ? [cfg.battery_device_id] : []);
      cfg.battery_devices = ids.map((id) => ({ id, cap_soc: 'measure_battery' }));
      changed = true;
    }

    if (changed) {
      this.homey.settings.set('ems_config', cfg);
      this.log('[EMS] config migrated');
    }
  }

  _getChargerState(id) {
    if (!this._chargerStates.has(id)) {
      this._chargerStates.set(id, {
        currentAmps:       null,
        currentPhases:     null,
        pendingStepAmps:   null,
        pendingStepSince:  null,
        lastDownStepAt:    null,
        lastPhaseSwitchAt: null,
      });
    }
    return this._chargerStates.get(id);
  }

  // ─── Tick ─────────────────────────────────────────────────────────────────

  _startTick() {
    this._stopTick();
    this._tickTimer = this.homey.setInterval(
      () => this._tick().catch((e) => this.log(`[EMS] tick: ${e.message}`)),
      TICK_MS,
    );
    this._tick().catch((e) => this.log(`[EMS] init tick: ${e.message}`));
  }

  _stopTick() {
    if (this._tickTimer) { this.homey.clearInterval(this._tickTimer); this._tickTimer = null; }
  }

  async _tick() {
    // Read config once per tick and pass it down — avoids repeated settings reads
    const cfg     = this._getConfig();
    const enabled = this.getCapabilityValue('onoff') !== false;
    const hasKey  = !!this.getSetting('homey_api_key');

    if (!enabled || !hasKey) {
      if (hasKey) {
        const [gridW, chargers] = await Promise.all([this._getGridW(cfg), this._getChargers(cfg)]);
        if (gridW !== null) {
          const totalChargerW = chargers.reduce((s, c) => s + (c.powerW ?? 0), 0);
          await this._set('measure_power.surplus', totalChargerW - gridW);
        }
      }
      if (!enabled) {
        await this._set('ems_mode', 'disabled');
        await this._set('ems_status_text', 'EMS disabled');
      } else {
        await this._set('ems_mode', 'error');
        await this._set('ems_status_text', 'No API key — add it in device settings');
      }
      return;
    }

    const [battery, gridW, chargers, heatPumps] = await Promise.all([
      this._getBattery(cfg),
      this._getGridW(cfg),
      this._getChargers(cfg),
      this._getHeatPumps(cfg),
    ]);
    if (gridW !== null) {
      const totalChargerW = chargers.reduce((s, c) => s + (c.powerW ?? 0), 0);
      await this._set('measure_power.surplus', totalChargerW - gridW);
    }
    await this._evaluate(battery, gridW, chargers, cfg);
    await this._evaluateHeatPumps(battery, gridW, heatPumps, cfg);
  }

  // ─── Device reads ──────────────────────────────────────────────────────────

  async _getBattery(cfg) {
    const devices = cfg.battery_devices || [];
    if (!devices.length) return { soc: null, powerW: null };
    const [socs, powers] = await Promise.all([
      Promise.all(devices.map((d) => this._api.getCapability(d.id, d.cap_soc || 'measure_battery'))),
      Promise.all(devices.map((d) => d.cap_power ? this._api.getCapability(d.id, d.cap_power) : Promise.resolve(null))),
    ]);
    const validSoc   = socs.filter((s) => s !== null);
    const validPower = powers.filter((p) => p !== null);
    return {
      soc:    validSoc.length   ? Math.min(...validSoc)                 : null,
      powerW: validPower.length ? validPower.reduce((a, b) => a + b, 0) : null,
    };
  }

  async _getGridW(cfg) {
    const devices = [...(cfg.inverter_devices || []), ...(cfg.meter_devices || [])];
    if (!devices.length) return null;
    const vals  = await Promise.all(devices.map((d) =>
      this._api.getCapability(d.id, d.cap_power || 'measure_power.grid_active_power'),
    ));
    const valid = vals.filter((v) => v !== null);
    return valid.length ? valid.reduce((a, b) => a + b, 0) : null;
  }

  async _getChargers(cfg) {
    const cfgs = cfg.chargers || [];
    return Promise.all(cfgs.map(async (c) => {
      const capState = c.cap_state || 'evcharger_charging_state';
      const capPower = c.cap_power || 'measure_power';
      const [rawState, rawPowerW] = await Promise.all([
        this._api.getCapability(c.id, capState)
          .then((v) => v !== null ? v : this._api.getCapability(c.id, 'onoff')),
        this._api.getCapability(c.id, capPower),
      ]);
      const st = this._getChargerState(c.id);
      // Estimate power from known amps when cap_power returns null
      const powerW     = rawPowerW ?? ((st.currentAmps ?? 0) * (st.currentPhases ?? (parseInt(c.ev_phases) || 3)) * 230);
      const connected  = rawState === 'connected' || rawState === 'charging' || rawState === true;
      return {
        id:          c.id,
        maxAmps:     parseInt(c.max_amps)  || 16,
        minAmps:     parseInt(c.min_amps)  || AMPS_LADDER[0], // per-charger minimum (defaults to 6 A)
        connected,
        powerW,
        capCurrent:  c.cap_current  || null,
        phases:      parseInt(c.ev_phases) || 3,
        phaseSwitch: c.phase_switch === true,
      };
    }));
  }

  async _getHeatPumps(cfg) {
    const cfgs = cfg.heat_pump_devices || [];
    return Promise.all(cfgs.map(async (c) => {
      const powerW = await this._api.getCapability(c.id, c.cap_power || 'measure_power');
      return { id: c.id, powerW: powerW ?? 0, minSurplusW: Number(c.min_surplus_w) || 2000 };
    }));
  }

  async _heatPumpSetOn(id, on) {
    if (!this._heatPumpStates.has(id)) this._heatPumpStates.set(id, { isOn: null });
    const st = this._heatPumpStates.get(id);
    if (st.isOn === on) return;
    const card = on ? 'ems_start_heat_pump' : 'ems_stop_heat_pump';
    this.log(`[EMS] heat pump ${id}: ${on ? 'start' : 'stop'}`);
    await this.homey.flow
      .getTriggerCard(card)
      .trigger({ heat_pump_device_id: id }, { heat_pump_device_id: id })
      .catch((e) => this.log(`[EMS] heat pump trigger ${card} failed: ${e.message}`));
    st.isOn = on;
  }

  // ─── Charger control ──────────────────────────────────────────────────────

  async _chargerStop(id) {
    this.log(`[EMS] charger ${id}: stop`);
    await this.homey.flow
      .getTriggerCard('ems_set_charger_current')
      .trigger({ amps: 0, phase1: 0, phase2: 0, phase3: 0, charger_device_id: id }, { charger_device_id: id });
    const st = this._getChargerState(id);
    st.currentAmps = null; st.pendingStepAmps = null; st.pendingStepSince = null;
    st.currentPhases = null;
  }

  async _chargerSetAmps(id, amps, phases) {
    const st = this._getChargerState(id);

    if (st.currentAmps === null) {
      await this.homey.flow
        .getTriggerCard('ems_start_charger')
        .trigger({ charger_device_id: id }, { charger_device_id: id })
        .catch(() => {});
    }

    const p1 = amps;
    const p2 = phases >= 2 ? amps : 0;
    const p3 = phases >= 3 ? amps : 0;
    this.log(`[EMS] charger ${id}: ${amps}A / ${phases}ph (L1=${p1} L2=${p2} L3=${p3})`);
    await this.homey.flow
      .getTriggerCard('ems_set_charger_current')
      .trigger({ amps, phase1: p1, phase2: p2, phase3: p3, charger_device_id: id }, { charger_device_id: id });
    st.currentAmps = amps;
  }

  _bestPhases(budgetW) {
    return budgetW >= MIN_3PH_W ? 3 : 1;
  }

  // ─── Evaluation ───────────────────────────────────────────────────────────

  async _evaluate(battery, gridW, chargers, cfg) {
    const minSoc = Number(cfg.min_battery_soc ?? 80);
    const now    = Date.now();

    const anyConnected = chargers.some((c) => c.connected);
    const totalW       = chargers.reduce((s, c) => s + c.powerW, 0);

    // ── P0: Instant charging ─────────────────────────────────────────────────
    if (this.getCapabilityValue('charge_now') === true) {
      if (!anyConnected) {
        await this._setMode('idle');
        await this._set('ems_status_text', 'Sofortladen aktiv — kein EV verbunden');
        return;
      }
      for (const c of chargers) {
        if (!c.connected) continue;
        await this._chargerSetAmps(c.id, c.maxAmps, c.phases);
        this._getChargerState(c.id).currentPhases = c.phases;
      }
      const parts = chargers.filter((c) => c.connected).map((c) => `${c.maxAmps}A/${c.phases}ph`).join(' + ');
      await this._setMode('instant_ev');
      await this._set('ems_status_text', `Sofortladen · ${parts}`);
      return;
    }

    // ── P1: Battery priority ─────────────────────────────────────────────────
    let batOverflowMode = false;
    if (battery.soc !== null && minSoc > 0 && battery.soc < minSoc) {
      const batCharging    = battery.powerW !== null && battery.powerW > 0;
      const exportSurplusW = gridW !== null ? -gridW : 0;
      const hasOverflow    = batCharging && exportSurplusW >= MIN_CHARGE_W;

      if (!hasOverflow) {
        // Only stop chargers that EMS has running — avoids repeated stop triggers each tick
        for (const c of chargers) {
          if (this._getChargerState(c.id).currentAmps !== null) await this._chargerStop(c.id);
        }
        await this._setMode('battery_priority');
        await this._set('ems_status_text', `Battery priority — ${Math.round(battery.soc)}% < ${minSoc}%`);
        return;
      }
      batOverflowMode = true;
    }

    // ── P2: No EV connected ──────────────────────────────────────────────────
    if (!anyConnected) {
      this._importSince = null;
      for (const c of chargers) {
        if (this._getChargerState(c.id).currentAmps !== null) await this._chargerStop(c.id);
      }
      await this._setMode('idle');
      await this._set('ems_status_text', 'No EV connected');
      return;
    }

    // ── P3: Off-peak ──────────────────────────────────────────────────────────
    if (!batOverflowMode && this.getCapabilityValue('offpeak_enabled') === true && this._isOffpeak(cfg)) {
      this._importSince = null; // clear stale import timer so solar mode starts fresh after off-peak
      const opAmps = parseInt(cfg.offpeak_amps ?? 16, 10);
      for (const c of chargers) {
        if (!c.connected) continue;
        const opPhases = c.phaseSwitch ? 3 : c.phases;
        const st       = this._getChargerState(c.id);
        if (st.currentAmps !== opAmps || st.currentPhases !== opPhases) {
          await this._chargerSetAmps(c.id, opAmps, opPhases);
          if (c.phaseSwitch) { st.currentPhases = opPhases; st.lastPhaseSwitchAt = now; }
        }
      }
      const n = chargers.filter((c) => c.connected).length;
      await this._setMode('offpeak_ev');
      await this._set('ems_status_text', `Off-peak · ${opAmps}A × ${n} charger${n > 1 ? 's' : ''}`);
      return;
    }

    // ── Import guard (60 s) ───────────────────────────────────────────────────
    const importing       = gridW !== null && gridW >= IMPORT_ACT_W;
    this._importSince     = importing ? (this._importSince ?? now) : null;
    const sustainedImport = importing && (now - this._importSince) >= IMPORT_HOLD_MS;
    if (sustainedImport) this._importSince = null;

    // ── Solar surplus allocation ───────────────────────────────────────────────
    let budgetW    = totalW - (gridW ?? 0);
    const statuses = [];

    for (const charger of chargers) {
      if (!charger.connected) {
        if (this._getChargerState(charger.id).currentAmps !== null) await this._chargerStop(charger.id);
        continue;
      }
      const result = await this._stepCharger(charger, budgetW, charger.phases, now, gridW, sustainedImport);
      statuses.push(result);
      budgetW = Math.max(0, budgetW - result.allocatedW);
    }

    // ── Mode & status ────────────────────────────────────────────────────────
    const socStr   = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
    const batPwStr = battery.powerW !== null
      ? (battery.powerW >= 0 ? ` ↑${Math.round(battery.powerW)}W` : ` ↓${Math.round(Math.abs(battery.powerW))}W`)
      : '';
    const active = statuses.filter((s) => s.allocatedW > 0);
    if (!active.length) {
      await this._setMode(batOverflowMode ? 'battery_priority' : 'holding');
      await this._set('ems_status_text', batOverflowMode
        ? `Battery priority + overflow · waiting${socStr}${batPwStr}`
        : `Waiting for solar surplus${socStr}${batPwStr}`);
    } else {
      const parts  = active.map((s) => `${s.amps}A/${s.phases}ph`).join(' + ');
      const prefix = batOverflowMode ? 'Bat priority + overflow · ' : 'Solar · ';
      await this._setMode('solar_ev');
      await this._set('ems_status_text', `${prefix}${parts}${active.length > 1 ? ` (${active.length} chargers)` : ''}${socStr}${batPwStr}`);
    }
  }

  async _evaluateHeatPumps(battery, gridW, heatPumps, cfg) {
    if (!heatPumps.length) return;
    if (this.getCapabilityValue('onoff') === false) return;

    const minSoc      = Number(cfg.min_battery_soc ?? 80);
    const batLow      = battery.soc !== null && minSoc > 0 && battery.soc < minSoc;
    const batChg      = battery.powerW !== null && battery.powerW > 0;
    const exportW     = gridW !== null ? -gridW : 0;
    const batOverflow = batLow && batChg && exportW >= MIN_CHARGE_W; // consistent with _evaluate

    for (const hp of heatPumps) {
      const wantOn = (batLow && !batOverflow) ? false : exportW >= hp.minSurplusW;
      await this._heatPumpSetOn(hp.id, wantOn);
    }
  }

  async _stepCharger(charger, budgetW, configPhases, now, gridW, forcedDown) {
    const st  = this._getChargerState(charger.id);
    const cur = st.currentAmps ?? 0;

    // ── Phase determination ───────────────────────────────────────────────────
    let phases = configPhases;
    if (charger.phaseSwitch) {
      const targetPhases  = this._bestPhases(budgetW);
      const currentPhases = st.currentPhases ?? configPhases;

      if (targetPhases !== currentPhases) {
        const canSwitch = !st.lastPhaseSwitchAt || (now - st.lastPhaseSwitchAt) >= PHASE_SWITCH_COOLDOWN_MS;
        if (canSwitch && !forcedDown) {
          const maxA      = targetPhases === 1 ? Math.min(charger.maxAmps, 16) : charger.maxAmps;
          const newLadder = AMPS_LADDER
            .filter((a) => a >= charger.minAmps && a <= maxA)
            .map((a) => ({ amps: a, watts: a * targetPhases * 230 }));
          const newTarget = [...newLadder].reverse().find((r) => r.watts <= budgetW) ?? newLadder[0];
          if (newTarget) {
            st.currentPhases     = targetPhases;
            st.lastPhaseSwitchAt = now;
            st.pendingStepAmps   = null;
            st.pendingStepSince  = null;
            await this._chargerSetAmps(charger.id, newTarget.amps, targetPhases);
            return { amps: newTarget.amps, phases: targetPhases, allocatedW: newTarget.amps * targetPhases * 230 };
          }
        }
        phases = currentPhases;
      } else {
        phases = currentPhases;
      }
    }

    // ── Build amp ladder for effective phase count ────────────────────────────
    const maxA   = (charger.phaseSwitch && phases === 1) ? Math.min(charger.maxAmps, 16) : charger.maxAmps;
    const ladder = AMPS_LADDER
      .filter((a) => a >= charger.minAmps && a <= maxA)
      .map((a) => ({ amps: a, watts: a * phases * 230 }));
    const minW   = ladder[0]?.watts ?? (charger.minAmps * phases * 230);

    if (budgetW < minW && cur === 0) {
      return { amps: 0, phases, allocatedW: 0 };
    }

    // Find highest rung that fits the budget
    let target = null;
    for (const r of ladder) { if (r.watts <= budgetW) target = r; }

    if (!target) {
      if (cur > 0) { st.lastDownStepAt = now; await this._chargerStop(charger.id); }
      return { amps: 0, phases, allocatedW: 0 };
    }

    // Forced step-down (sustained import) — bypass anti-thrash
    if (forcedDown && target.amps < cur) {
      st.pendingStepAmps = null; st.pendingStepSince = null;
      st.lastDownStepAt  = now;
      await this._chargerSetAmps(charger.id, target.amps, phases);
      return { amps: target.amps, phases, allocatedW: target.amps * phases * 230 };
    }

    if (target.amps > cur) {
      // ── Step up ──────────────────────────────────────────────────────────
      const okCooldown = !st.lastDownStepAt || (now - st.lastDownStepAt) >= FLIP_COOLDOWN_MS;
      if (!okCooldown) return { amps: cur, phases, allocatedW: cur * phases * 230 };

      if (budgetW < target.watts + UP_MARGIN_W) {
        st.pendingStepAmps = null; st.pendingStepSince = null;
        return { amps: cur, phases, allocatedW: cur * phases * 230 };
      }

      if (st.pendingStepAmps !== target.amps) {
        st.pendingStepAmps = target.amps; st.pendingStepSince = now;
        return { amps: cur, phases, allocatedW: cur * phases * 230 };
      }

      if ((now - st.pendingStepSince) < STEP_HOLD_MS) {
        return { amps: cur, phases, allocatedW: cur * phases * 230 };
      }

      st.pendingStepAmps = null; st.pendingStepSince = null;
      await this._chargerSetAmps(charger.id, target.amps, phases);
      return { amps: target.amps, phases, allocatedW: target.amps * phases * 230 };

    } else if (target.amps < cur) {
      // ── Step down ────────────────────────────────────────────────────────
      if (gridW !== null && gridW <= -200) {
        st.pendingStepAmps = null; st.pendingStepSince = null;
        return { amps: cur, phases, allocatedW: cur * phases * 230 };
      }
      st.pendingStepAmps = null; st.pendingStepSince = null;
      st.lastDownStepAt  = now;
      await this._chargerSetAmps(charger.id, target.amps, phases);
      return { amps: target.amps, phases, allocatedW: target.amps * phases * 230 };

    } else {
      // ── Steady ───────────────────────────────────────────────────────────
      st.pendingStepAmps = null; st.pendingStepSince = null;
      if (cur === 0) await this._chargerSetAmps(charger.id, target.amps, phases);
      return { amps: target.amps, phases, allocatedW: target.amps * phases * 230 };
    }
  }

  // ─── Flow trigger on mode change ──────────────────────────────────────────

  async _triggerModeFlow(mode) {
    const flowId = this._getConfig()[`flow_on_${mode}`];
    if (!flowId) return;
    try { await this._api.triggerFlow(flowId); } catch (err) {
      this.log(`[EMS] flow trigger failed: ${err.message}`);
    }
  }

  // ─── State helpers ────────────────────────────────────────────────────────

  async _setMode(mode) {
    const prev = this.getCapabilityValue('ems_mode');
    if (prev !== mode) {
      await this._set('ems_mode', mode);
      this.homey.flow.getDeviceTriggerCard('ems_mode_changed').trigger(this, { mode }).catch(() => {});
      await this._triggerModeFlow(mode);
    }
  }

  async _set(cap, value) {
    if (!this.hasCapability(cap) || this.getCapabilityValue(cap) === value) return;
    await this.setCapabilityValue(cap, value).catch(() => {});
  }

  async _ensureCapabilities() {
    for (const cap of ['ems_mode', 'ems_status_text', 'measure_power.surplus', 'offpeak_enabled', 'charge_now']) {
      if (!this.hasCapability(cap)) {
        this.log(`[EMS] addCapability: ${cap}`);
        await this.addCapability(cap).catch((e) => this.error(`[EMS] addCapability ${cap} failed:`, e));
      }
    }
    if (this.getCapabilityValue('measure_power.surplus') === null) {
      await this.setCapabilityValue('measure_power.surplus', 0).catch(() => {});
    }
    if (this.getCapabilityValue('offpeak_enabled') === null) {
      const cfg = this._getConfig();
      await this.setCapabilityValue('offpeak_enabled', cfg.offpeak_enabled === true)
        .catch((e) => this.error('[EMS] setCapabilityValue offpeak_enabled failed:', e));
    }
    if (this.getCapabilityValue('charge_now') === null) {
      await this.setCapabilityValue('charge_now', false)
        .catch((e) => this.error('[EMS] setCapabilityValue charge_now failed:', e));
    }
  }

  _isOffpeak(cfg) {
    const s = this._parseTime(cfg.offpeak_start || '22:00');
    const e = this._parseTime(cfg.offpeak_end   || '06:00');
    if (s === null || e === null) return false;
    const d = new Date();
    const t = d.getHours() * 60 + d.getMinutes(); // single Date instance — no minute-rollover race
    return s > e ? (t >= s || t < e) : (t >= s && t < e);
  }

  _parseTime(str) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(str ?? '').trim());
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  }

}

module.exports = EmsDevice;
