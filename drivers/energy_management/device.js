'use strict';

const { Device }    = require('homey');
const HomeyLocalApi = require('../../lib/homey-local-api');

const TICK_MS                  = 15_000;
const STEP_HOLD_MS             = 30_000;
const IMPORT_HOLD_MS           = 60_000;
const FLIP_COOLDOWN_MS         = 5 * 60_000;
const SIMPLE_MIN_RUN_MS        = 5 * 60_000;  // min run time for HP/boiler/pool before stop allowed
const EMS_HISTORY_MAX          = 400;          // max history events kept in memory + settings
const PHASE_SWITCH_COOLDOWN_MS = 10 * 60_000;
const IMPORT_ACT_W             = 200;
const EXPORT_GUARD_W           = 200;
const UP_MARGIN_W              = 250;
const MIN_3PH_W                = 6 * 3 * 230;      // 4140 W — minimum viable 3-phase load
const AMPS_LADDER              = [6, 8, 10, 12, 14, 16, 20, 25, 32];
const MIN_CHARGE_W             = AMPS_LADDER[0] * 230; // 1380 W — single-phase minimum

class EmsDevice extends Device {

  async onInit() {
    this._chargerStates   = new Map(); // deviceId → per-charger anti-thrash state
    this._heatPumpStates  = new Map(); // deviceId → { isOn: null | boolean }
    this._boilerStates    = new Map();
    this._poolStates      = new Map();
    this._batteryStates   = new Map(); // deviceId → { fullFired: boolean, lowFired: boolean }
    this._warmupDone      = false;     // first tick only reads state, no flows fired
    this._tickInProgress  = false;     // prevents overlapping concurrent ticks
    this._importSince     = null;
    this._tickTimer       = null;
    this._offpeakFmt      = null;      // cached Intl.DateTimeFormat (keyed by tz)
    this._offpeakFmtTz    = null;
    this._emsHistory      = JSON.parse(JSON.stringify(this.homey.settings.get('ems_history') || []));
    this._tickCount       = 0;
    this._lastLoggedMode  = null; // null forces first _setMode call to always log

    this._api = new HomeyLocalApi({
      homey:  this.homey,
      apiKey: this.getSetting('homey_api_key') || '',
    });

    await this._ensureCapabilities();
    await this._migrateConfig(); // run once on startup, writes back if format changed

    this.registerCapabilityListener('onoff',           (v) => this._onEnabledChanged(v));
    this.registerCapabilityListener('offpeak_enabled', (v) => {
      const cfg = this._getConfig();
      cfg.offpeak_enabled = v;
      this.homey.settings.set('ems_config', cfg);
      this._tick().catch(() => {});
    });
    this.registerCapabilityListener('charge_now',      () => this._tick().catch(() => {}));

    this._startTick();
    this.log('[EMS] initialized');
  }

  async onDeleted() { this._stopTick(); }
  async onUninit()  { this._stopTick(); this._saveHistory(); }

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
      this._set('ems_status_text', '—');
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
    if (cfg._migrated) return;
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
    if (!cfg.meter_devices)  { cfg.meter_devices  = []; changed = true; }
    if (!cfg.house_devices)  { cfg.house_devices  = []; changed = true; }

    if (!cfg.battery_devices) {
      const ids = cfg.battery_device_ids || (cfg.battery_device_id ? [cfg.battery_device_id] : []);
      cfg.battery_devices = ids.map((id) => ({ id, cap_soc: 'measure_battery' }));
      changed = true;
    }

    cfg._migrated = true;
    if (changed) this.log('[EMS] config migrated');
    this.homey.settings.set('ems_config', cfg);
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
    if (this._tickInProgress) return;
    this._tickInProgress = true;
    try {
      await this._tickBody();
    } catch (e) {
      this.log(`[EMS] tick error: ${e.message}`);
    } finally {
      this._tickInProgress = false;
      this._warmupDone = true;
      this._tickCount += 1;
      if (this._tickCount % 20 === 0) this._saveHistory(); // save every ~5 min
    }
  }

  async _tickBody() {
    // Read config once per tick and pass it down — avoids repeated settings reads
    const cfg     = this._getConfig();
    const enabled = this.getCapabilityValue('onoff') !== false;
    const hasKey  = !!this.getSetting('homey_api_key');

    if (!enabled || !hasKey) {
      if (hasKey) {
        const [gridW, pvW, battery, chargers] = await Promise.all([
          this._getGridW(cfg), this._getPvW(cfg), this._getBattery(cfg), this._getChargers(cfg),
        ]);
        if (gridW !== null) {
          await this._set('measure_solar_surplus', Math.max(0, Math.round(-gridW)));
          await this._set('measure_grid_power', Math.round(gridW));
          const houseW = await this._getHouseW(cfg, gridW, pvW, battery);
          if (houseW !== null) await this._set('measure_house_power', Math.round(houseW));
        }
        if (pvW !== null) await this._set('measure_pv_power', Math.round(pvW));
        if (battery.powerW !== null) await this._set('measure_battery_power', Math.round(battery.powerW));
      }
      if (!enabled) {
        await this._set('ems_mode', 'disabled');
        await this._set('ems_status_text', '—');
      } else {
        await this._set('ems_mode', 'error');
        await this._set('ems_status_text', 'Kein API-Schlüssel — bitte in den Geräteeinstellungen eintragen');
      }
      return;
    }

    const [battery, gridW, pvW, chargers, heatPumps, boilers, pools] = await Promise.all([
      this._getBattery(cfg),
      this._getGridW(cfg),
      this._getPvW(cfg),
      this._getChargers(cfg),
      this._getSimpleDevices('heat_pump_devices', cfg),
      this._getSimpleDevices('boiler_devices', cfg),
      this._getSimpleDevices('pool_devices', cfg),
    ]);
    if (gridW !== null) {
      await this._set('measure_solar_surplus', Math.max(0, Math.round(-gridW)));
      await this._set('measure_grid_power', Math.round(gridW));
    }
    if (pvW !== null) await this._set('measure_pv_power', Math.round(pvW));
    if (battery.powerW !== null) await this._set('measure_battery_power', Math.round(battery.powerW));
    if (gridW !== null) {
      const houseW = await this._getHouseW(cfg, gridW, pvW, battery);
      if (houseW !== null) await this._set('measure_house_power', Math.round(houseW));
    }
    if (this._warmupDone) await this._checkBatteryTriggers(cfg, battery);

    const priorityOrder = Array.isArray(cfg.device_priority_order) && cfg.device_priority_order.length
      ? cfg.device_priority_order
      : ['charger', 'heat_pump', 'boiler', 'pool'];
    let effectiveGridW = gridW;
    for (const deviceType of priorityOrder) {
      if (deviceType === 'charger') {
        const allocatedW = await this._evaluate(battery, effectiveGridW, chargers, cfg);
        if (effectiveGridW !== null && allocatedW) effectiveGridW += allocatedW;
      } else if (deviceType === 'heat_pump') {
        const allocatedW = await this._evaluateHeatPumps(battery, effectiveGridW, heatPumps, cfg);
        if (effectiveGridW !== null && allocatedW) effectiveGridW += allocatedW;
      } else if (deviceType === 'boiler') {
        const allocatedW = await this._evaluateBoilers(battery, effectiveGridW, boilers, cfg);
        if (effectiveGridW !== null && allocatedW) effectiveGridW += allocatedW;
      } else if (deviceType === 'pool') {
        const allocatedW = await this._evaluatePool(battery, effectiveGridW, pools, cfg);
        if (effectiveGridW !== null && allocatedW) effectiveGridW += allocatedW;
      }
    }

    // When no chargers configured, _evaluate never sets mode/status — do it here
    const simpleDevicesAll = [...heatPumps, ...boilers, ...pools];
    if (!chargers.length && !simpleDevicesAll.length) {
      await this._setMode('not_configured', 'Konfiguriere EMS in App Settings');
      await this._set('ems_status_text', 'Konfiguriere EMS in App Settings');
    } else if (!chargers.length && simpleDevicesAll.length) {
      const activeHpCount     = heatPumps.filter((d) => this._heatPumpStates.get(d.id)?.isOn).length;
      const activeBoilerCount = boilers.filter((d)   => this._boilerStates.get(d.id)?.isOn).length;
      const activePoolCount   = pools.filter((d)     => this._poolStates.get(d.id)?.isOn).length;
      const activeCount       = activeHpCount + activeBoilerCount + activePoolCount;
      const socStr            = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
      if (activeCount) {
        // Pick mode matching the single active device type; fall back to solar_hp for mixed
        let mode = 'solar_hp';
        if (!activeHpCount && activeBoilerCount && !activePoolCount) mode = 'solar_boiler';
        else if (!activeHpCount && !activeBoilerCount && activePoolCount) mode = 'solar_pool';
        const stTextActive = `${activeCount} Gerät${activeCount > 1 ? 'e' : ''} aktiv${socStr}`;
        await this._setMode(mode, stTextActive);
        await this._set('ems_status_text', stTextActive);
      } else {
        const stTextHolding = `kein Überschuss${socStr}`;
        await this._setMode('holding', stTextHolding);
        await this._set('ems_status_text', stTextHolding);
      }
    }
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

  async _checkBatteryTriggers(cfg, battery) {
    const devices    = cfg.battery_devices || [];
    const minSoc     = Number(cfg.min_battery_soc ?? 80);
    const fullSoc    = Number(cfg.battery_full_soc ?? 95);

    for (const device of devices) {
      const soc = await this._api.getCapability(device.id, device.cap_soc || 'measure_battery').catch(() => null);
      if (soc === null) continue;

      if (!this._batteryStates.has(device.id)) {
        this._batteryStates.set(device.id, { fullFired: false, lowFired: false });
      }
      const st = this._batteryStates.get(device.id);

      if (soc >= fullSoc && !st.fullFired) {
        st.fullFired = true;
        st.lowFired  = false;
        this.log(`[EMS] battery ${device.id}: SOC ${Math.round(soc)}% ≥ ${fullSoc}% → ems_battery_full`);
        await this.homey.flow
          .getTriggerCard('ems_battery_full')
          .trigger({ battery_device_id: device.id, soc: Math.round(soc) }, { battery_device_id: device.id })
          .catch((e) => this.log(`[EMS] trigger ems_battery_full failed: ${e.message}`));
      } else if (soc < fullSoc - 5) {
        st.fullFired = false;
      }

      if (soc < minSoc && !st.lowFired) {
        st.lowFired  = true;
        st.fullFired = false;
        this.log(`[EMS] battery ${device.id}: SOC ${Math.round(soc)}% < ${minSoc}% → ems_battery_low`);
        await this.homey.flow
          .getTriggerCard('ems_battery_low')
          .trigger({ battery_device_id: device.id, soc: Math.round(soc) }, { battery_device_id: device.id })
          .catch((e) => this.log(`[EMS] trigger ems_battery_low failed: ${e.message}`));
      } else if (soc >= minSoc + 5) {
        st.lowFired = false;
      }
    }
  }

  async _getHouseW(cfg, gridW, pvW, battery) {
    const devices = cfg.house_devices || [];
    if (devices.length) {
      const vals  = await Promise.all(devices.map((d) =>
        this._api.getCapability(d.id, d.cap_power || 'measure_power'),
      ));
      const valid = vals.filter((v) => v !== null && v >= 0);
      return valid.length ? valid.reduce((a, b) => a + b, 0) : null;
    }
    // Fallback: calculate from energy balance
    if (gridW === null) return null;
    return Math.max(0, (pvW ?? 0) + gridW - (battery.powerW ?? 0));
  }

  async _getPvW(cfg) {
    const devices = cfg.inverter_devices || [];
    if (!devices.length) return null;
    const vals  = await Promise.all(devices.map((d) =>
      this._api.getCapability(d.id, d.cap_power || 'measure_power'),
    ));
    const valid = vals.filter((v) => v !== null && v >= 0); // PV is never negative
    return valid.length ? valid.reduce((a, b) => a + b, 0) : null;
  }

  async _getGridW(cfg) {
    const devices = cfg.meter_devices || [];
    if (!devices.length) {
      this.log('[EMS] _getGridW: no meter_devices configured');
      return null;
    }
    const vals  = await Promise.all(devices.map((d) => {
      const cap = d.cap_power || 'measure_power';
      return this._api.getCapability(d.id, cap);
    }));
    const valid = vals.filter((v) => v !== null);
    if (!valid.length) this.log('[EMS] _getGridW: all capability reads returned null');
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
      // "connected" = car is physically plugged in (Easee: plugged_in_paused / ready_to_charge / car_connected / completed / charging)
      const DISCONNECTED_STATES = new Set(['standby', 'plugged_out', 'unplugged', 'available', 'idle', null, undefined, false]);
      const connected  = !DISCONNECTED_STATES.has(rawState);
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

  async _getSimpleDevices(devicesKey, cfg) {
    const cfgs = cfg[devicesKey] || [];
    return Promise.all(cfgs.map(async (c) => {
      const powerW = c.cap_power ? await this._api.getCapability(c.id, c.cap_power) : null;
      return { id: c.id, powerW, minSurplusW: Number(c.min_surplus_w) || 2000 };
    }));
  }

  async _simpleDeviceSetOn(id, on, stateMap, startCard, stopCard, tokenName) {
    if (!stateMap.has(id)) stateMap.set(id, { isOn: null, startedAt: null });
    const st = stateMap.get(id);
    if (st.isOn === on) return;
    if (on) st.startedAt = Date.now();
    else st.startedAt = null;
    st.isOn = on; // always update state so second tick sees correct baseline
    if (!this._warmupDone) return; // first tick: observe only, no flows
    const devName = await this.homey.devices.getDevice({ id }).then(d => d.name).catch(() => id.slice(0, 8));
    this._addHistoryEvent('device', on ? 'start' : 'stop', devName, id);
    const card = on ? startCard : stopCard;
    this.log(`[EMS] ${tokenName} ${id}: ${on ? 'start' : 'stop'}`);
    await this.homey.flow
      .getTriggerCard(card)
      .trigger({ [tokenName]: id }, { [tokenName]: id })
      .catch((e) => this.log(`[EMS] trigger ${card} failed: ${e.message}`));
  }

  async _evaluateSimpleDevices(battery, gridW, devices, stateMap, startCard, stopCard, tokenName, cfgControlKey, cfg) {
    if (!devices.length) return 0;
    if (cfg[cfgControlKey] === false) return 0;

    const minSoc      = Number(cfg.min_battery_soc ?? 80);
    const batLow      = battery.soc !== null && minSoc > 0 && battery.soc < minSoc;
    const batChg      = battery.powerW !== null && battery.powerW > 0;
    const exportW     = gridW !== null ? -gridW : 0;
    const batOverflow = batLow && batChg && exportW >= MIN_CHARGE_W;

    const now = Date.now();
    let allocatedDeltaW = 0;
    for (const device of devices) {
      const st           = stateMap.get(device.id);
      const wasOn        = st?.isOn ?? false;
      const hpPowerW     = (wasOn && device.powerW != null) ? device.powerW : 0;
      const effectiveW   = exportW + hpPowerW;
      const surplusOk    = effectiveW >= device.minSurplusW;
      const inHoldTime   = !surplusOk && wasOn && st?.startedAt && (now - st.startedAt) < SIMPLE_MIN_RUN_MS;
      // Battery protection always overrides hold time; surplus check uses hold time as fallback
      const wantOn       = (batLow && !batOverflow) ? false : (surplusOk || inHoldTime);
      if (inHoldTime) this.log(`[EMS] ${tokenName} ${device.id}: hold-time active (${Math.round((now - st.startedAt) / 1000)}s < ${SIMPLE_MIN_RUN_MS / 1000}s)`);
      await this._simpleDeviceSetOn(device.id, wantOn, stateMap, startCard, stopCard, tokenName);
      // Device just switched on this tick: its consumption isn't in gridW yet.
      // Use minSurplusW as an estimate so subsequent priority steps see reduced surplus.
      if (!wasOn && wantOn) allocatedDeltaW += device.minSurplusW;
    }
    return allocatedDeltaW;
  }

  // ─── Charger control ──────────────────────────────────────────────────────

  async _chargerStop(id) {
    this.log(`[EMS] charger ${id}: stop`);
    this._addHistoryEvent('charger', 'stop', '0A', id);
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
    const prevAmps = st.currentAmps;
    if (prevAmps === null || prevAmps !== amps) {
      this._addHistoryEvent('charger', prevAmps === null ? 'start' : 'set_amps', `${amps}A/${phases}ph`, id);
    }
    this.log(`[EMS] charger ${id}: ${amps}A / ${phases}ph (L1=${p1} L2=${p2} L3=${p3})`);
    await this.homey.flow
      .getTriggerCard('ems_set_charger_current')
      .trigger({ amps, phase1: p1, phase2: p2, phase3: p3, charger_device_id: id }, { charger_device_id: id });
    st.currentAmps   = amps;
    st.currentPhases = phases; // always track phases so phase-switch logic sees correct state next tick
  }

  _bestPhases(budgetW) {
    return budgetW >= MIN_3PH_W ? 3 : 1;
  }

  // ─── Evaluation ───────────────────────────────────────────────────────────

  async _evaluate(battery, gridW, chargers, cfg) {
    if (!chargers.length) return 0;
    if (cfg.charger_control === false) return 0;
    const minSoc = Number(cfg.min_battery_soc ?? 80);
    const now    = Date.now();

    const anyConnected = chargers.some((c) => c.connected);
    const totalW       = chargers.reduce((s, c) => s + c.powerW, 0);

    // ── P0: Instant charging ─────────────────────────────────────────────────
    if (this.getCapabilityValue('charge_now') === true) {
      if (!anyConnected) {
        await this._setMode('idle', 'Kein EV verbunden');
        await this._set('ems_status_text', 'Kein EV verbunden');
        return 0;
      }
      for (const c of chargers) {
        if (!c.connected) continue;
        const st = this._getChargerState(c.id);
        if (this._warmupDone && (st.currentAmps !== c.maxAmps || st.currentPhases !== c.phases)) {
          await this._chargerSetAmps(c.id, c.maxAmps, c.phases);
        }
      }
      const parts = chargers.filter((c) => c.connected).map((c) => `${c.maxAmps}A/${c.phases}ph`).join(' + ');
      const stTextInstant = parts;
      await this._setMode('instant_ev', stTextInstant);
      await this._set('ems_status_text', stTextInstant);
      return chargers.filter((c) => c.connected).reduce((s, c) => s + c.maxAmps * c.phases * 230, 0);
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
        const stTextBat = `${Math.round(battery.soc)}% < ${minSoc}%`;
        await this._setMode('battery_priority', stTextBat);
        await this._set('ems_status_text', stTextBat);
        return 0;
      }
      batOverflowMode = true;
    }

    // ── P2: No EV connected ──────────────────────────────────────────────────
    if (!anyConnected) {
      this._importSince = null;
      for (const c of chargers) {
        if (this._getChargerState(c.id).currentAmps !== null) await this._chargerStop(c.id);
      }
      await this._setMode('idle', 'Kein EV verbunden');
      await this._set('ems_status_text', 'Kein EV verbunden');
      return 0;
    }

    // ── P3: Off-peak ──────────────────────────────────────────────────────────
    const offpeakWin = this._offpeakWindow(cfg);
    if (!batOverflowMode && this.getCapabilityValue('offpeak_enabled') === true && offpeakWin.active) {
      // Solar-first: if there's enough export surplus to cover the minimum step,
      // let the solar logic handle it — free energy outranks cheap grid energy.
      const solarFirst    = cfg.offpeak_solar_first !== false; // default true
      const solarCanClaim = solarFirst && gridW !== null && gridW <= -(MIN_CHARGE_W);

      if (!solarCanClaim) {
        this._importSince = null; // clear stale import timer so solar mode starts fresh after off-peak
        const opAmps = offpeakWin.amps;
        for (const c of chargers) {
          if (!c.connected) continue;
          const opPhases = c.phaseSwitch ? 3 : c.phases;
          const st       = this._getChargerState(c.id);
          if (this._warmupDone && (st.currentAmps !== opAmps || st.currentPhases !== opPhases)) {
            await this._chargerSetAmps(c.id, opAmps, opPhases);
            if (c.phaseSwitch) st.lastPhaseSwitchAt = now;
          }
        }
        const connectedChargers = chargers.filter((c) => c.connected);
        const n = connectedChargers.length;
        const stTextOffpeak = `${opAmps}A × ${n} Lader`;
        await this._setMode('offpeak_ev', stTextOffpeak);
        await this._set('ems_status_text', stTextOffpeak);
        return connectedChargers.reduce((s, c) => s + opAmps * (c.phaseSwitch ? 3 : c.phases) * 230, 0);
      }
      // else: solar has surplus — fall through to solar surplus logic below
    }

    // ── Import guard (60 s) ───────────────────────────────────────────────────
    const importing       = gridW !== null && gridW >= IMPORT_ACT_W;
    this._importSince     = importing ? (this._importSince ?? now) : null;
    const sustainedImport = importing && (now - this._importSince) >= IMPORT_HOLD_MS;
    if (sustainedImport) this._importSince = null;

    // ── Solar surplus allocation ───────────────────────────────────────────────
    // Battery correction: penalise EV budget only when battery is discharging AND
    // grid is importing — both sources draining simultaneously is too much EV load.
    // When grid is still exporting, solar surplus exists and the inverter manages
    // the battery itself; applying correction here caused start/stop oscillation.
    const batDischarging = battery.powerW !== null && battery.powerW < 0;
    const batCorr  = batDischarging && gridW !== null && gridW > 0 ? battery.powerW : 0;
    let budgetW    = totalW - (gridW ?? 0) + batCorr;
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
      const stTextWait = batOverflowMode
        ? `Überschuss vorhanden · wartend${socStr}${batPwStr}`
        : `kein Überschuss${socStr}${batPwStr}`;
      await this._setMode(batOverflowMode ? 'battery_priority' : 'holding', stTextWait);
      await this._set('ems_status_text', stTextWait);
      return 0;
    } else {
      const parts  = active.map((s) => `${s.amps}A/${s.phases}ph`).join(' + ');
      const prefix = batOverflowMode ? 'Überschuss · ' : '';
      const stTextSolar = `${prefix}${parts}${active.length > 1 ? ` (${active.length} Lader)` : ''}${socStr}${batPwStr}`;
      await this._setMode('solar_ev', stTextSolar);
      await this._set('ems_status_text', stTextSolar);
      return active.reduce((s, r) => s + r.allocatedW, 0);
    }
  }

  async _evaluateHeatPumps(battery, gridW, heatPumps, cfg) {
    return this._evaluateSimpleDevices(battery, gridW, heatPumps, this._heatPumpStates,
      'ems_start_heat_pump', 'ems_stop_heat_pump', 'heat_pump_device_id', 'heat_pump_control', cfg);
  }

  async _evaluateBoilers(battery, gridW, boilers, cfg) {
    return this._evaluateSimpleDevices(battery, gridW, boilers, this._boilerStates,
      'ems_start_boiler', 'ems_stop_boiler', 'boiler_device_id', 'boiler_control', cfg);
  }

  async _evaluatePool(battery, gridW, pools, cfg) {
    return this._evaluateSimpleDevices(battery, gridW, pools, this._poolStates,
      'ems_start_pool', 'ems_stop_pool', 'pool_device_id', 'pool_control', cfg);
  }

  async _stepCharger(charger, budgetW, configPhases, now, gridW, forcedDown) {
    const st  = this._getChargerState(charger.id);
    const cur = st.currentAmps ?? 0;

    // First tick after startup: observe only — no charger commands.
    // Prevents a spurious start/stop caused by stale phase state (currentPhases=null)
    // triggering an immediate phase-switch before the 30 s STEP_HOLD_MS guard kicks in.
    if (!this._warmupDone) return { amps: cur, phases: configPhases, allocatedW: cur * configPhases * 230 };

    // ── Phase determination ───────────────────────────────────────────────────
    let phases = configPhases;
    if (charger.phaseSwitch) {
      const targetPhases  = this._bestPhases(budgetW);
      const currentPhases = st.currentPhases ?? configPhases;

      if (targetPhases !== currentPhases) {
        if (cur > 0) {
          // Charger already running: attempt immediate phase switch (with cooldown).
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
          phases = currentPhases; // waiting for cooldown — keep current phases
        } else {
          // Charger stopped: use target phases for the amp ladder so the
          // pending-step mechanism starts at the correct phase count.
          // _chargerSetAmps will persist currentPhases when it fires.
          phases = targetPhases;
        }
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
      if (cur > 0) {
        // Export guard: if we're still exporting, hold at minimum instead of stopping.
        // Prevents oscillation when budget dips just below minW due to battery correction
        // while solar surplus is visibly present.
        if (!forcedDown && gridW !== null && gridW <= -EXPORT_GUARD_W) {
          const minRung = ladder[0];
          if (minRung) {
            if (minRung.amps !== cur) await this._chargerSetAmps(charger.id, minRung.amps, phases);
            return { amps: minRung.amps, phases, allocatedW: minRung.amps * phases * 230 };
          }
        }
        st.lastDownStepAt = now;
        await this._chargerStop(charger.id);
      }
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

      if (cur > 0 && budgetW < target.watts + UP_MARGIN_W) {
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
      if (gridW !== null && gridW <= -EXPORT_GUARD_W) {
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

  async _setMode(mode, newStatusText = null) {
    const prev = this.getCapabilityValue('ems_mode');
    if (prev !== mode) {
      await this._set('ems_mode', mode);
      this.homey.flow.getDeviceTriggerCard('ems_mode_changed').trigger(this, { mode }).catch(() => {});
      await this._triggerModeFlow(mode);
    }
    if (!this._warmupDone) return; // first tick: observe only, no history
    if (mode !== this._lastLoggedMode) {
      const label = newStatusText != null ? newStatusText : (this.getCapabilityValue('ems_status_text') || '');
      this._addHistoryEvent('mode', mode, label);
      this._lastLoggedMode = mode;
    }
  }

  async _set(cap, value) {
    if (!this.hasCapability(cap) || this.getCapabilityValue(cap) === value) return;
    await this.setCapabilityValue(cap, value).catch(() => {});
  }

  // ─── History ──────────────────────────────────────────────────────────────

  _addHistoryEvent(type, event, label, deviceId = null) {
    this._emsHistory.push({ ts: Date.now(), type, event, label, deviceId });
    if (this._emsHistory.length > EMS_HISTORY_MAX) this._emsHistory.splice(0, this._emsHistory.length - EMS_HISTORY_MAX);
    // Persist immediately for mode/device events — charger events are saved periodically
    if (type === 'mode' || type === 'device') this._saveHistory();
  }

  _saveHistory() {
    this.homey.settings.set('ems_history', this._emsHistory.slice(-EMS_HISTORY_MAX));
  }

  getEmsHistory() {
    return this._emsHistory.slice(-EMS_HISTORY_MAX);
  }

  async _ensureCapabilities() {
    if (this.hasCapability('measure_power.surplus')) await this.removeCapability('measure_power.surplus').catch(() => {});
    if (this.hasCapability('measure_power.grid'))    await this.removeCapability('measure_power.grid').catch(() => {});
    if (this.hasCapability('measure_power.pv'))      await this.removeCapability('measure_power.pv').catch(() => {});
    if (this.hasCapability('measure_power.house'))   await this.removeCapability('measure_power.house').catch(() => {});
    if (this.hasCapability('measure_ev_budget'))     await this.removeCapability('measure_ev_budget').catch(() => {});
    for (const cap of ['ems_mode', 'ems_status_text', 'measure_solar_surplus', 'measure_pv_power', 'measure_house_power', 'measure_grid_power', 'measure_battery_power', 'offpeak_enabled', 'charge_now']) {
      if (!this.hasCapability(cap)) {
        this.log(`[EMS] addCapability: ${cap}`);
        await this.addCapability(cap).catch((e) => this.error(`[EMS] addCapability ${cap} failed:`, e));
      }
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

  // Returns { active: bool, amps: number } for the current off-peak window.
  // Supports separate weekday vs weekend windows; timezone-aware via Homey clock.
  _offpeakWindow(cfg) {
    const tz  = this.homey.clock?.getTimezone?.() || 'UTC';
    if (!this._offpeakFmt || this._offpeakFmtTz !== tz) {
      this._offpeakFmt   = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      this._offpeakFmtTz = tz;
    }
    const fmt = this._offpeakFmt;
    const parts  = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    const t      = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
    const isWeekend = parts.weekday === 'Sat' || parts.weekday === 'Sun';
    const useWeekend = cfg.offpeak_weekend_differs === true && isWeekend;

    const startKey = useWeekend ? 'offpeak_weekend_start' : 'offpeak_start';
    const endKey   = useWeekend ? 'offpeak_weekend_end'   : 'offpeak_end';
    const s = this._parseTime(cfg[startKey] || '22:00');
    const e = this._parseTime(cfg[endKey]   || '06:00');
    if (s === null || e === null) return { active: false, amps: 16 };

    const active = s > e ? (t >= s || t < e) : (t >= s && t < e);
    return { active, amps: parseInt(cfg.offpeak_amps ?? 16, 10) };
  }

  _parseTime(str) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(str ?? '').trim());
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  }

}

module.exports = EmsDevice;
