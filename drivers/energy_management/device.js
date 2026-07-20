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
const GRID_SENSOR_HOLD_TICKS   = 4;            // use last-valid gridW for up to 4 ticks (60 s) on sensor failure
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
    this._boilerStates        = new Map();
    this._poolStates          = new Map();
    this._dehumidifierStates  = new Map();
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

    // ── App start / update event ──────────────────────────────────────────────
    const currentVersion = this.homey.app?.manifest?.version ?? '?';
    const lastVersion    = this.homey.settings.get('ems_app_version') ?? null;
    this.homey.settings.set('ems_app_version', currentVersion);
    const isAppUpdate = lastVersion !== null && lastVersion !== currentVersion;
    this._addHistoryEvent(
      'system',
      isAppUpdate ? 'app_update' : 'app_start',
      isAppUpdate ? `v${lastVersion} → v${currentVersion}` : `v${currentVersion}`,
    );
    this._lastValidGridW   = null; // sensor failure protection: last known good grid value
    this._lastValidGridWAt = null;
    this._gridSensorFail   = 0;   // consecutive ticks without valid grid reading
    this._exportLimitActive      = false; // export limit coordinator state
    this._exportLimitActivatedAt = null;  // hold timer: when export limit was last activated
    this._loggedNoMeterDevices   = false; // one-shot log flag for missing meter config
    this._schedulerFired         = new Map(); // taskId → Date of last fire

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

  // Called from settings/index.html (via HomeyLocalApi POST /config) when the user saves EMS
  // configuration. Restarts the tick loop so the new settings take effect immediately.
  onConfigChanged() {
    this._stopTick();
    this._startTick();
  }

  _onEnabledChanged(enabled) {
    if (!enabled) {
      this._setMode('disabled', '—').catch(() => {});
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

    if (cfg.throttle_budget_w !== undefined && cfg.orange_budget_w === undefined) {
      cfg.orange_budget_w = cfg.throttle_budget_w;
      delete cfg.throttle_budget_w;
      changed = true;
    }
    if (cfg.ev_reserve_w !== undefined && cfg.orange_budget_w === undefined) {
      cfg.orange_budget_w = cfg.ev_reserve_w;
      delete cfg.ev_reserve_w;
      changed = true;
    }

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
    this._warmupDone           = false;
    this._loggedNoMeterDevices = false;
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
        await this._setMode('disabled', '—');
        await this._set('ems_status_text', '—');
      } else {
        await this._setMode('error', 'Kein API-Schlüssel — bitte in den Geräteeinstellungen eintragen');
        await this._set('ems_status_text', 'Kein API-Schlüssel — bitte in den Geräteeinstellungen eintragen');
      }
      return;
    }

    const [battery, gridW, pvW, chargers, heatPumps, boilers, pools, dehumidifiers] = await Promise.all([
      this._getBattery(cfg),
      this._getGridW(cfg),
      this._getPvW(cfg),
      this._getChargers(cfg),
      this._getSimpleDevices('heat_pump_devices', cfg),
      this._getSimpleDevices('boiler_devices', cfg),
      this._getSimpleDevices('pool_devices', cfg),
      this._getSimpleDevices('dehumidifier_devices', cfg),
    ]);
    if (gridW !== null) {
      await this._set('measure_solar_surplus', Math.max(0, Math.round(-gridW)));
      await this._set('measure_grid_power', Math.round(gridW));
    }
    if (pvW !== null) await this._set('measure_pv_power', Math.round(pvW));
    if (battery.powerW !== null) await this._set('measure_battery_power', Math.round(battery.powerW));
    let houseW = null;
    if (gridW !== null) {
      houseW = await this._getHouseW(cfg, gridW, pvW, battery);
      if (houseW !== null) await this._set('measure_house_power', Math.round(houseW));
    }
    if (this._warmupDone) await this._checkBatteryTriggers(cfg, battery);
    if (this._warmupDone) await this._checkScheduler(cfg).catch((e) => this.error('[EMS] scheduler:', e.message));

    // ── Sensor failure guard ──────────────────────────────────────────────────
    // _getGridW returns null after GRID_SENSOR_HOLD_TICKS consecutive failures.
    // Hold all device control and report error; PV/battery display is still updated above.
    if (gridW === null) {
      const failSecs = this._gridSensorFail * Math.round(TICK_MS / 1000);
      const msg = `Netzstrom-Sensor: ${failSecs}s kein Signal — EMS wartet`;
      await this._setMode('error', msg);
      await this._set('ems_status_text', msg);
      return;
    }

    const priorityOrder = Array.isArray(cfg.device_priority_order) && cfg.device_priority_order.length
      ? cfg.device_priority_order
      : ['charger', 'heat_pump', 'boiler', 'pool', 'dehumidifier'];
    let effectiveGridW = gridW;
    // Orange zone: expand effective surplus by orange budget so devices can borrow from battery charging.
    // The budget is shared across all device types via effectiveGridW — as each type allocates power,
    // effectiveGridW rises (less virtual export), naturally limiting subsequent types.
    const { batReserve: _isOrangeZone } = this._batteryZones(cfg, battery);
    const _orangeBudgetW = Number(cfg.orange_budget_w ?? 0);
    if (_isOrangeZone && _orangeBudgetW > 0 && effectiveGridW !== null) {
      effectiveGridW -= _orangeBudgetW;
    }
    for (const deviceType of priorityOrder) {
      if (deviceType === 'charger') {
        const prevChargerW = chargers.reduce((s, c) => s + c.powerW, 0);
        const allocatedW   = await this._evaluateEvChargers(battery, effectiveGridW, chargers, cfg, pvW, houseW);
        // Adjust only by the delta: the existing charger draw is already reflected in gridW
        const deltaW = allocatedW - prevChargerW;
        if (effectiveGridW !== null && deltaW !== 0) effectiveGridW += deltaW;
      } else if (deviceType === 'heat_pump') {
        const allocatedW = await this._evaluateHeatPumps(battery, effectiveGridW, heatPumps, cfg);
        if (effectiveGridW !== null && allocatedW) effectiveGridW += allocatedW;
      } else if (deviceType === 'boiler') {
        const allocatedW = await this._evaluateBoilers(battery, effectiveGridW, boilers, cfg);
        if (effectiveGridW !== null && allocatedW) effectiveGridW += allocatedW;
      } else if (deviceType === 'pool') {
        const allocatedW = await this._evaluatePool(battery, effectiveGridW, pools, cfg);
        if (effectiveGridW !== null && allocatedW) effectiveGridW += allocatedW;
      } else if (deviceType === 'dehumidifier') {
        const allocatedW = await this._evaluateDehumidifier(battery, effectiveGridW, dehumidifiers, cfg);
        if (effectiveGridW !== null && allocatedW) effectiveGridW += allocatedW;
      }
    }

    // ── Export limit coordinator ──────────────────────────────────────────────
    if (this._warmupDone) {
      await this._evaluateExportLimit(cfg, battery, gridW)
        .catch((e) => this.log(`[EMS] export limit: ${e.message}`));
    }

    // When no chargers configured, _evaluate never sets mode/status — do it here
    const simpleDevicesAll = [...heatPumps, ...boilers, ...pools, ...dehumidifiers];
    if (!chargers.length && !simpleDevicesAll.length) {
      await this._setMode('not_configured', 'Konfiguriere EMS in App Settings');
      await this._set('ems_status_text', 'Konfiguriere EMS in App Settings');
    } else if (!chargers.length && simpleDevicesAll.length) {
      const activeHpCount           = heatPumps.filter((d)     => this._heatPumpStates.get(d.id)?.isOn).length;
      const activeBoilerCount       = boilers.filter((d)       => this._boilerStates.get(d.id)?.isOn).length;
      const activePoolCount         = pools.filter((d)         => this._poolStates.get(d.id)?.isOn).length;
      const activeDehumidifierCount = dehumidifiers.filter((d) => this._dehumidifierStates.get(d.id)?.isOn).length;
      const activeCount             = activeHpCount + activeBoilerCount + activePoolCount + activeDehumidifierCount;
      const socStr            = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
      if (activeCount) {
        // Pick mode matching the single active device type; fall back to solar_hp for mixed
        let mode = 'solar_hp';
        if (!activeHpCount && activeBoilerCount && !activePoolCount && !activeDehumidifierCount) mode = 'solar_boiler';
        else if (!activeHpCount && !activeBoilerCount && activePoolCount && !activeDehumidifierCount) mode = 'solar_pool';
        else if (!activeHpCount && !activeBoilerCount && !activePoolCount && activeDehumidifierCount) mode = 'solar_dehumidifier';
        const stTextActive = `${activeCount} Gerät${activeCount > 1 ? 'e' : ''} aktiv${socStr}`;
        await this._setMode(mode, stTextActive);
        await this._set('ems_status_text', stTextActive);
      } else {
        // Show battery-aware status when no device is active
        const { minSoc: _minSoc, minSocLow: _minSocLow, hasLowZone: _hasLow,
                batReserve: _batRes, batHardStop: _batHard } = this._batteryZones(cfg, battery);
        let stTextHolding, holdMode;
        if (_batHard) {
          const limit      = _hasLow ? _minSocLow : _minSoc;
          stTextHolding    = `${Math.round(battery.soc)}% < ${limit}%`;
          holdMode         = 'battery_priority';
        } else if (_batRes) {
          stTextHolding    = `Reserve · kein Überschuss${socStr}`;
          holdMode         = 'battery_priority';
        } else {
          stTextHolding    = `kein Überschuss${socStr}`;
          holdMode         = 'holding';
        }
        await this._setMode(holdMode, stTextHolding);
        await this._set('ems_status_text', stTextHolding);
      }
    }
  }

  // ─── Device reads ──────────────────────────────────────────────────────────

  async _getBattery(cfg) {
    const devices = cfg.battery_devices || [];
    if (!devices.length) return { soc: null, powerW: null, socPerDevice: {} };
    const [socs, powers] = await Promise.all([
      Promise.all(devices.map((d) => this._api.getCapability(d.id, d.cap_soc || 'measure_battery'))),
      Promise.all(devices.map((d) => d.cap_power ? this._api.getCapability(d.id, d.cap_power) : Promise.resolve(null))),
    ]);
    // Build per-device SOC map so _checkBatteryTriggers can reuse already-fetched values
    const socPerDevice = {};
    devices.forEach((d, i) => { socPerDevice[d.id] = socs[i]; });
    const validSoc   = socs.filter((s) => s !== null);
    const validPower = powers.filter((p) => p !== null);
    return {
      soc:          validSoc.length   ? Math.min(...validSoc)                 : null,
      powerW:       validPower.length ? validPower.reduce((a, b) => a + b, 0) : null,
      socPerDevice,
    };
  }

  async _checkBatteryTriggers(cfg, battery) {
    const devices    = cfg.battery_devices || [];
    const minSoc     = Number(cfg.min_battery_soc ?? 80);
    const fullSoc    = Number(cfg.battery_full_soc ?? 95);

    for (const device of devices) {
      // Reuse per-device SOC already fetched in _getBattery — avoids a second API round-trip
      const soc = battery.socPerDevice?.[device.id] ?? null;
      if (soc === null) continue;

      if (!this._batteryStates.has(device.id)) {
        this._batteryStates.set(device.id, { fullFired: false, lowFired: false });
      }
      const st = this._batteryStates.get(device.id);

      if (soc >= fullSoc && !st.fullFired) {
        st.fullFired = true;
        st.lowFired  = false;
        this.log(`[EMS] battery ${device.id}: SOC ${Math.round(soc)}% ≥ ${fullSoc}% → ems_battery_full`);
        this._postNotification(`EMS: Batterie voll — ${Math.round(soc)}%`);
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
        this._postNotification(`EMS: Batterie niedrig — ${Math.round(soc)}%`);
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
    // Fallback: energy balance PV + grid − battery − chargers = house
    // Subtract EMS-known charger consumption so the displayed house load doesn't include the EV charger.
    if (gridW === null) return null;
    let chargerW = 0;
    for (const st of this._chargerStates.values()) {
      if (st.currentAmps != null && st.currentPhases != null) {
        chargerW += st.currentAmps * st.currentPhases * 230;
      }
    }
    return Math.max(0, (pvW ?? 0) + gridW - (battery.powerW ?? 0) - chargerW);
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
      if (!this._loggedNoMeterDevices) {
        this.log('[EMS] _getGridW: no meter_devices configured');
        this._loggedNoMeterDevices = true;
      }
      return null;
    }
    const vals  = await Promise.all(devices.map((d) => {
      const cap = d.cap_power || 'measure_power';
      return this._api.getCapability(d.id, cap);
    }));
    const valid = vals.filter((v) => v !== null);
    if (!valid.length) {
      this._gridSensorFail += 1;
      if (this._gridSensorFail <= GRID_SENSOR_HOLD_TICKS && this._lastValidGridW !== null) {
        this.log(`[EMS] _getGridW: sensor fail #${this._gridSensorFail}/${GRID_SENSOR_HOLD_TICKS}, using cached ${this._lastValidGridW}W`);
        return this._lastValidGridW; // stale but safe for a short window
      }
      this.log('[EMS] _getGridW: persistent failure, all reads returned null');
      return null;
    }
    const result         = valid.reduce((a, b) => a + b, 0);
    this._lastValidGridW   = result;
    this._lastValidGridWAt = Date.now();
    this._gridSensorFail   = 0;
    return result;
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
      // When EMS has amps set, use estimated power as a floor — prevents false "no surplus"
      // stop during the startup lag where the charger reports 0 W but the grid meter already
      // sees the draw, collapsing budgetW to near zero.
      const estimatedW = st.currentAmps > 0
        ? st.currentAmps * (st.currentPhases ?? (parseInt(c.ev_phases) || 3)) * 230
        : 0;
      const powerW     = rawPowerW != null ? Math.max(rawPowerW, estimatedW) : estimatedW;
      // "connected" = car is physically plugged in (Easee: plugged_in_paused / ready_to_charge / car_connected / completed / charging)
      const DISCONNECTED_STATES = new Set(['standby', 'plugged_out', 'unplugged', 'available', 'idle', null, undefined, false]);
      const connected  = !DISCONNECTED_STATES.has(rawState);
      return {
        id:          c.id,
        maxAmps:     parseInt(c.max_amps,  10) || 16,
        minAmps:     parseInt(c.min_amps,  10) || AMPS_LADDER[0],
        connected,
        powerW,
        capCurrent:  c.cap_current  || null,
        phases:      parseInt(c.ev_phases, 10) || 3,
        phaseSwitch: c.phase_switch === true,
      };
    }));
  }

  async _getSimpleDevices(devicesKey, cfg) {
    const cfgs = cfg[devicesKey] || [];
    return Promise.all(cfgs.map(async (c) => {
      const [powerW, onoff] = await Promise.all([
        c.cap_power ? this._api.getCapability(c.id, c.cap_power) : Promise.resolve(null),
        this._api.getCapability(c.id, 'onoff'),
      ]);
      return {
        id:                  c.id,
        name:                c.name || c.id.slice(0, 8),
        powerW,
        onoff,
        minSurplusW:         Number(c.min_surplus_w)         || 2000,
        startSustainMs:      Number(c.start_sustain_s        || 60) * 1000,
        stopGraceMs:         Number(c.stop_grace_s           || 60) * 1000,
        maxRunMs:            Number(c.max_run_min            || 0)  * 60_000,
        restartCooldownMs:   Number(c.restart_cooldown_min   || 5)  * 60_000,
      };
    }));
  }

  async _simpleDeviceSetOn(id, name, on, stateMap, startCard, stopCard, tokenName) {
    const st = stateMap.get(id); // guaranteed initialized by _evaluateSimpleDevices
    if (!this._warmupDone) { return; } // first tick: state already initialised from actual device, no flows fired
    if (st.isOn === on) return;
    if (on) st.startedAt = Date.now();
    else st.startedAt = null;
    st.isOn = on;
    this._postNotification(`EMS: ${name} ${on ? 'gestartet' : 'gestoppt'}`);
    this._addHistoryEvent('device', on ? 'start' : 'stop', name, id);
    const card = on ? startCard : stopCard;
    this.log(`[EMS] ${tokenName} ${id}: ${on ? 'start' : 'stop'}`);
    await this.homey.flow
      .getTriggerCard(card)
      .trigger({ [tokenName]: id }, { [tokenName]: id })
      .catch((e) => this.log(`[EMS] trigger ${card} failed: ${e.message}`));
  }

  _batteryZones(cfg, battery) {
    const minSoc     = Number(cfg.min_battery_soc     ?? 80);
    const minSocLow  = Number(cfg.min_battery_soc_low ?? 0);
    const hasLowZone = minSocLow > 0 && minSocLow < minSoc;
    const batLow      = battery.soc !== null && minSoc > 0 && battery.soc < minSoc;
    const batReserve = hasLowZone && battery.soc !== null
                       && battery.soc >= minSocLow && battery.soc < minSoc;
    const batHardStop = batLow && !batReserve;
    return { minSoc, minSocLow, hasLowZone, batLow, batReserve, batHardStop };
  }

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
        const actuallyOn = device.onoff === true;
        stateMap.set(device.id, { isOn: actuallyOn, startedAt: actuallyOn ? Date.now() : null, surplusOkSince: null, surplusBadSince: null, powerDropStoppedAt: null });
      }
      const st         = stateMap.get(device.id);
      const wasOn      = st.isOn ?? false;
      const hpPowerW   = (wasOn && device.powerW != null) ? device.powerW : 0;
      const effectiveW = runningExportW + hpPowerW;
      const surplusOk  = effectiveW >= device.minSurplusW;
      const runElapsedMs = wasOn && st.startedAt !== null ? (now - st.startedAt) : 0;
      const pastMinRun   = wasOn && runElapsedMs >= SIMPLE_MIN_RUN_MS;
      const inMaxRun     = wasOn && device.maxRunMs > 0 && runElapsedMs < device.maxRunMs;
      const maxRunDone   = wasOn && device.maxRunMs > 0 && runElapsedMs >= device.maxRunMs;
      const inHoldTime   = wasOn && !pastMinRun && !inMaxRun; // hold for first SIMPLE_MIN_RUN_MS; false while max-run is active

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

      // ── Diagnostic logging ────────────────────────────────────────────────
      if (inMaxRun) {
        this.log(`[EMS] ${tokenName} ${device.id}: max-run active (${Math.round(runElapsedMs / 1000)}s / ${device.maxRunMs / 1000}s)`);
      } else if (inHoldTime) {
        this.log(`[EMS] ${tokenName} ${device.id}: hold-time active (${Math.round(runElapsedMs / 1000)}s < ${SIMPLE_MIN_RUN_MS / 1000}s)`);
      } else if (!wasOn && surplusOk && !restartOk) {
        this.log(`[EMS] ${tokenName} ${device.id}: restart-cooldown active (${Math.round((now - st.powerDropStoppedAt) / 1000)}s / ${device.restartCooldownMs / 1000}s)`);
      } else if (!wasOn && surplusOk && !startOk && device.startSustainMs > 0 && st.surplusOkSince) {
        this.log(`[EMS] ${tokenName} ${device.id}: start-sustain pending (${Math.round((now - st.surplusOkSince) / 1000)}s / ${device.startSustainMs / 1000}s)`);
      } else if (inGracePeriod) {
        this.log(`[EMS] ${tokenName} ${device.id}: stop-grace active (${Math.round((now - st.surplusBadSince) / 1000)}s / ${device.stopGraceMs / 1000}s)`);
      }

      // ── Power-drop: device finished its cycle (skip when battery protection already stopped it) ───
      if (!inMaxRun && !batHardStop && wasOn && pastMinRun && device.powerW !== null && device.powerW < device.minSurplusW) {
        wantOn = false;
        st.powerDropStoppedAt = now;
        this.log(`[EMS] ${tokenName} ${device.id}: power dropped to ${device.powerW}W < ${device.minSurplusW}W → stop (restart cooldown ${device.restartCooldownMs / 60_000} min)`);
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
  }

  // ─── Charger control ──────────────────────────────────────────────────────

  async _chargerStop(id) {
    this.log(`[EMS] charger ${id}: stop`);
    this._addHistoryEvent('charger', 'stop', '0A', id);
    await this.homey.flow
      .getTriggerCard('ems_set_charger_current')
      .trigger({ amps: 0, phase1: 0, phase2: 0, phase3: 0, charger_device_id: id }, { charger_device_id: id })
      .catch((e) => this.log(`[EMS] charger ${id}: stop trigger failed: ${e.message}`));
    const st = this._getChargerState(id);
    st.currentAmps = null; st.pendingStepAmps = null; st.pendingStepSince = null;
    st.currentPhases = null;
    st.lastDownStepAt = Date.now(); // always apply FLIP_COOLDOWN_MS after any stop
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
      .trigger({ amps, phase1: p1, phase2: p2, phase3: p3, charger_device_id: id }, { charger_device_id: id })
      .catch((e) => this.log(`[EMS] charger ${id}: set trigger failed: ${e.message}`));
    st.currentAmps   = amps;
    st.currentPhases = phases; // always track phases so phase-switch logic sees correct state next tick
  }

  _bestPhases(budgetW) {
    return budgetW >= MIN_3PH_W ? 3 : 1;
  }

  // ─── Evaluation ───────────────────────────────────────────────────────────

  async _evaluateEvChargers(battery, gridW, chargers, cfg, pvW = null, houseW = null) {
    if (!chargers.length) return 0;
    if (cfg.charger_control === false) return 0;
    const { minSoc, minSocLow, hasLowZone, batLow, batReserve } = this._batteryZones(cfg, battery);
    const now = Date.now();

    const anyConnected = chargers.some((c) => c.connected);
    const totalW       = chargers.reduce((s, c) => s + c.powerW, 0);

    // ── P0: Instant charging ─────────────────────────────────────────────────
    if (this.getCapabilityValue('charge_now') === true) {
      if (!anyConnected) {
        const p0SocStr = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
        await this._setMode('idle', `kein EV verbunden${p0SocStr}`);
        await this._set('ems_status_text', `kein EV verbunden${p0SocStr}`);
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
    // Three zones based on SOC vs. two thresholds (min_soc_low < min_soc):
    //   soc ≥ min_soc               → normal operation
    //   min_soc_low ≤ soc < min_soc → orange zone: devices share orange budget
    //   soc < min_soc_low           → hard stop (with overflow exception for grid export)
    let batOverflowMode = false;
    let batReserveMode = false;

    if (batLow) {
      if (batReserve) {
        // Orange zone: devices share the orange budget; battery keeps solar priority
        batReserveMode = true;
      } else {
        // Hard stop zone: soc < minSocLow (or no low zone configured)
        const batCharging    = battery.powerW !== null && battery.powerW > 0;
        const exportSurplusW = gridW !== null ? -gridW : 0;

        // Hysteresis: require 2×MIN_CHARGE_W export to START overflow charging but only
        // ½×MIN_CHARGE_W to CONTINUE. Without this, starting the charger reduces the
        // apparent export (the EV wasn't yet drawing when the budget was computed), which
        // causes the condition to flip false on the very next tick → start/stop oscillation.
        const anyChargerRunning = chargers.some(
          (c) => (this._getChargerState(c.id).currentAmps ?? 0) > 0,
        );
        const overflowThreshold = anyChargerRunning ? MIN_CHARGE_W / 2 : MIN_CHARGE_W * 2;
        const hasOverflow       = batCharging && exportSurplusW >= overflowThreshold;

        if (!hasOverflow) {
          // Only stop chargers that EMS has running — avoids repeated stop triggers each tick
          for (const c of chargers) {
            if (this._getChargerState(c.id).currentAmps !== null) await this._chargerStop(c.id);
          }
          const socLimit  = hasLowZone ? minSocLow : minSoc;
          const stTextBat = `${Math.round(battery.soc)}% < ${socLimit}%`;
          await this._setMode('battery_priority', stTextBat);
          await this._set('ems_status_text', stTextBat);
          return 0;
        }
        batOverflowMode = true;
      }
    }

    // ── P2: No EV connected ──────────────────────────────────────────────────
    if (!anyConnected) {
      this._importSince = null;
      for (const c of chargers) {
        if (this._getChargerState(c.id).currentAmps !== null) await this._chargerStop(c.id);
      }
      const idleSocStr      = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
      const idleSurplusW    = gridW !== null ? Math.round(-gridW) : null;
      const idleSurplusStr  = idleSurplusW !== null && idleSurplusW > 0
        ? `${idleSurplusW} W Überschuss${idleSocStr}`
        : `kein Überschuss${idleSocStr}`;
      await this._setMode('idle', idleSurplusStr);
      await this._set('ems_status_text', idleSurplusStr);
      return 0;
    }

    // ── P3: Off-peak ──────────────────────────────────────────────────────────
    const offpeakWin = this._offpeakWindow(cfg);
    if (!batOverflowMode && !batReserveMode && this.getCapabilityValue('offpeak_enabled') === true && offpeakWin.active) {
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
    const batCharging    = battery.powerW !== null && battery.powerW > 0;
    const batCorr  = batDischarging && gridW !== null && gridW > 0 ? battery.powerW : 0;
    let budgetW    = totalW - (gridW ?? 0) + batCorr;

    // Green zone: battery is charging from solar → that power is also available to the EV
    // charger. The inverter reduces battery charging proportionally when the charger draws
    // more, so battery charging wattage counts as additional budget (= 100% solar − house).
    // This handles the common case where all PV flows into the battery (grid ≈ 0W) and the
    // grid-based budget alone would read near zero, preventing the charger from starting.
    if (!batOverflowMode && !batReserveMode && batCharging) budgetW += battery.powerW;

    // PV-based cross-check: pvW − houseW converges to the same value as the battery-boost
    // above when sensors are accurate, but takes precedence if it reads higher (handles
    // sensor lag or setups without a battery power sensor).
    if (!batOverflowMode && pvW !== null && houseW !== null) {
      const pvBudgetW = Math.max(0, pvW - houseW);
      if (pvBudgetW > budgetW) {
        this.log(`[EMS] PV budget ${Math.round(pvBudgetW)}W > battery-boost budget ${Math.round(budgetW)}W — using PV`);
        budgetW = pvBudgetW;
      }
    }

    // Orange zone: budget already expanded by orangeBudget via effectiveGridW (injected in main tick).
    // No override needed; batReserveMode only suppresses battery-boost addition below.

    // In overflow mode keep the budget below the 3-phase threshold so _stepCharger never
    // triggers a 1ph→3ph switch. That switch doubles the charger draw instantly, which
    // pulls the battery out of charging and breaks the overflow condition on the next tick.
    if (batOverflowMode) budgetW = Math.min(budgetW, MIN_3PH_W - 1);

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
        : batReserveMode
          ? `Orange Budget · kein Überschuss${socStr}${batPwStr}`
          : `kein Überschuss${socStr}${batPwStr}`;
      const waitMode = (batOverflowMode || batReserveMode) ? 'battery_priority' : 'holding';
      await this._setMode(waitMode, stTextWait);
      await this._set('ems_status_text', stTextWait);
      return 0;
    } else {
      const parts  = active.map((s) => `${s.amps}A/${s.phases}ph`).join(' + ');
      const prefix = batOverflowMode ? 'Überschuss · ' : batReserveMode ? 'Reserve · ' : '';
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

  async _evaluateDehumidifier(battery, gridW, dehumidifiers, cfg) {
    return this._evaluateSimpleDevices(battery, gridW, dehumidifiers, this._dehumidifierStates,
      'ems_start_dehumidifier', 'ems_stop_dehumidifier', 'dehumidifier_device_id', 'dehumidifier_control', cfg);
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

  // ─── Scheduler ───────────────────────────────────────────────────────────

  async _checkScheduler(cfg) {
    const tasks = Array.isArray(cfg.scheduled_tasks) ? cfg.scheduled_tasks : [];
    if (!tasks.length) return;
    const now        = new Date();
    const dayOfWeek  = now.getDay(); // 0=Sun, 1=Mon … 6=Sat
    const timeStr    = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    for (const task of tasks) {
      if (!task.enabled || !task.flow_id || task.time !== timeStr) continue;
      const lastFired = this._schedulerFired.get(task.id);
      if (lastFired && (now - lastFired) < 60_000) continue; // already fired this minute
      const shouldFire = task.type === 'daily' ||
        (task.type === 'weekday' && Array.isArray(task.weekdays) && task.weekdays.includes(dayOfWeek));
      if (!shouldFire) continue;
      this._schedulerFired.set(task.id, now);
      this.log(`[EMS] Scheduler: "${task.name}" → flow ${task.flow_id}`);
      this._api.triggerFlow(task.flow_id).catch((err) =>
        this.error(`[EMS] Scheduler: "${task.name}" trigger failed: ${err.message}`));
    }
  }

  // ─── State helpers ────────────────────────────────────────────────────────

  async _setMode(mode, newStatusText = null) {
    const prev = this.getCapabilityValue('ems_mode');
    if (prev !== mode) {
      await this._set('ems_mode', mode);
      if (this._warmupDone) {
        this.homey.flow.getDeviceTriggerCard('ems_mode_changed').trigger(this, { mode }).catch(() => {});
        await this._triggerModeFlow(mode);
      }
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

  _postNotification(excerpt) {
    if (!this.getSetting('enable_timeline_notifications')) return;
    this.homey.notifications.createNotification({ excerpt })
      .catch((e) => this.log(`[EMS] notification: ${e.message}`));
  }

  // ─── History ──────────────────────────────────────────────────────────────

  _addHistoryEvent(type, event, label, deviceId = null) {
    this._emsHistory.push({ ts: Date.now(), type, event, label, deviceId });
    if (this._emsHistory.length > EMS_HISTORY_MAX) this._emsHistory.splice(0, this._emsHistory.length - EMS_HISTORY_MAX);
    // Persist immediately for mode/device/system events — charger events are saved periodically
    if (type === 'mode' || type === 'device' || type === 'system') this._saveHistory();
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

  // ─── Export Limit Coordinator ─────────────────────────────────────────────
  // ─── Export Limit Coordinator ─────────────────────────────────────────────
  // Fires ems_inverter_export_limit_on / _off trigger cards automatically based on
  // battery SOC + grid export. Users link those triggers to inverter action cards.

  async _evaluateExportLimit(cfg, battery, gridW) {
    if (!cfg.export_limit_enabled) {
      // If the coordinator was just disabled while active, fire a deactivate to be safe
      if (this._exportLimitActive) {
        this._exportLimitActive      = false;
        this._exportLimitActivatedAt = null;
        const invId = (cfg.inverter_devices || [])[0]?.id;
        if (invId) {
          await this.homey.flow.getTriggerCard('ems_inverter_export_limit_off')
            .trigger({ inverter_device_id: invId }, { inverter_device_id: invId })
            .catch((e) => this.log(`[EMS] export limit OFF (disabled): ${e.message}`));
        }
      }
      return;
    }

    const trigSoc  = Number(cfg.export_limit_trigger_soc    ?? 95);
    const deactSoc = Number(cfg.export_limit_deactivate_soc ?? 90);
    const invId    = (cfg.inverter_devices || [])[0]?.id;

    if (!invId || battery.soc === null || gridW === null) return;

    const batFull   = battery.soc >= trigSoc;
    const exporting = gridW < -100; // at least 100 W export

    const shouldActivate   = !this._exportLimitActive && batFull && exporting;
    // Require a minimum hold time before deactivating: when the limit activates and cuts export,
    // the inverter stops exporting, which would immediately flip shouldDeactivate → oscillation.
    const EXPORT_LIMIT_HOLD_MS = 5 * 60_000;
    const heldLongEnough = !this._exportLimitActivatedAt
                           || (Date.now() - this._exportLimitActivatedAt) >= EXPORT_LIMIT_HOLD_MS;
    const shouldDeactivate = this._exportLimitActive && heldLongEnough
                             && (battery.soc < deactSoc || !exporting);

    if (shouldActivate) {
      this._exportLimitActive      = true;
      this._exportLimitActivatedAt = Date.now();
      this.log(`[EMS] export limit ON — SOC ${Math.round(battery.soc)}% ≥ ${trigSoc}%, export ${Math.round(-gridW)}W`);
      this._addHistoryEvent('mode', 'export_limit_on', `SOC ${Math.round(battery.soc)}% · export ${Math.round(-gridW)}W`);
      await this.homey.flow.getTriggerCard('ems_inverter_export_limit_on')
        .trigger({ inverter_device_id: invId }, { inverter_device_id: invId })
        .catch((e) => this.log(`[EMS] export limit ON trigger failed: ${e.message}`));
    } else if (shouldDeactivate) {
      this._exportLimitActive      = false;
      this._exportLimitActivatedAt = null;
      this.log(`[EMS] export limit OFF — SOC ${Math.round(battery.soc)}% < ${deactSoc}% or no export`);
      this._addHistoryEvent('mode', 'export_limit_off', `SOC ${Math.round(battery.soc)}%`);
      await this.homey.flow.getTriggerCard('ems_inverter_export_limit_off')
        .trigger({ inverter_device_id: invId }, { inverter_device_id: invId })
        .catch((e) => this.log(`[EMS] export limit OFF trigger failed: ${e.message}`));
    }
  }

}

module.exports = EmsDevice;
