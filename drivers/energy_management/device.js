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
const AMPS_LADDER              = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
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
    this._lastLoggedMode  = null; // null forces the first flushed mode to log
    this._tickMode        = null; // buffered mode decision for the current tick

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
    this._gridSensorFail   = 0;   // consecutive ticks without valid grid reading
    this._loggedNoMeterDevices   = false; // one-shot log flag for missing meter config
    this._schedulerFired         = new Map(); // taskId → Date of last fire
    this._devCache               = new Map(); // per-tick device-object cache (cleared each tick)

    // Export limit coordinator state — persisted so an active limit survives an
    // app restart (otherwise the OFF trigger would never fire and the inverter
    // would stay throttled until the next full ON/OFF cycle).
    let exportLimitStore = null;
    try { exportLimitStore = this.getStoreValue('exportLimitState'); } catch (e) { /* ignore */ }
    this._exportLimitActive      = exportLimitStore?.active === true;
    this._exportLimitActivatedAt = exportLimitStore?.activatedAt ?? null;
    if (this._exportLimitActive) this.log('[EMS] restored active export limit from store');

    // Variable electricity price (set by the ems_set_electricity_price flow),
    // persisted so it survives an app restart.
    this._variablePrice = null;
    try {
      const vp = this.getStoreValue('variablePrice');
      if (typeof vp === 'number') this._variablePrice = vp;
    } catch (e) { /* ignore */ }
    this._lastPriceFired = null; // last price value pushed to the capability

    // Per-car live state + SOC-rise tracking (which car is on the charger)
    this._carStates   = [];
    this._carSocTrack = {}; // carId → { soc, lastRiseAt }

    // Per-car target SOC { carId: percent }, set by the ems_set_car_target_soc
    // flow, persisted across restarts.
    this._carTargets = {};
    try {
      const ts = this.getStoreValue('carTargets');
      if (ts && typeof ts === 'object') this._carTargets = ts;
    } catch (e) { /* ignore */ }

    this._api = new HomeyLocalApi({
      homey:  this.homey,
      apiKey: this.getSetting('homey_api_key') || '',
    });

    await this._ensureCapabilities();
    await this._syncCarCapabilities(this._getConfig()); // add car caps only when a car is configured
    await this._migrateConfig(); // run once on startup, writes back if format changed

    this.registerCapabilityListener('onoff',           (v) => this._onEnabledChanged(v));
    this.registerCapabilityListener('offpeak_enabled', (v) => {
      const cfg = this._getConfig();
      cfg.offpeak_enabled = v;
      this.homey.settings.set('ems_config', cfg);
      this._tick().catch(() => {});
    });
    this.registerCapabilityListener('charge_now',      () => this._tick().catch(() => {}));

    // Flow action: external app sets the variable electricity price
    this.homey.flow.getActionCard('ems_set_electricity_price')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        const price = Number(args.price);
        if (!Number.isFinite(price)) throw new Error('Invalid price');
        this._variablePrice = price;
        await this.setStoreValue('variablePrice', price).catch(() => {});
        this.log(`[EMS] variable price set to ${price} via flow`);
        await this._updatePriceCapability(this._getConfig());
      });

    // Flow action: external app / schedule sets a car's target SOC.
    const carTargetCard = this.homey.flow.getActionCard('ems_set_car_target_soc');
    carTargetCard.registerArgumentAutocompleteListener('car', async (query) => {
      const cars = this._getConfig().car_devices || [];
      const q = (query || '').toLowerCase();
      return cars
        .filter((c) => !q || (c.name || '').toLowerCase().includes(q))
        .map((c) => ({ id: c.id, name: c.name || c.id }));
    });
    carTargetCard.registerRunListener(async (args) => {
      if (args.device.id !== this.id) return;
      const carId = args.car && args.car.id;
      if (!carId) throw new Error('No car selected');
      const soc = Math.round(Number(args.soc));
      if (!Number.isFinite(soc) || soc < 0 || soc > 100) throw new Error('Target SOC must be 0–100');
      this._carTargets[carId] = soc;
      await this.setStoreValue('carTargets', this._carTargets).catch(() => {});
      const car = (this._getConfig().car_devices || []).find((c) => c.id === carId);
      const carName = (car && car.name) || 'Car';
      this.log(`[EMS] car "${carName}" (${carId}) target SOC set to ${soc}% → trigger ems_set_car_target`);
      const capId = `measure_car_target_soc.${carId}`;
      await this._ensureCap(capId, true); // may be first use
      await this._setCapTitle(capId, `${carName} Target`);
      await this._set(capId, soc);
      // Relay to the vehicle: the created "Set charge <soc>%" flow filters on the
      // vehicle's device id + target_pct, so exactly the matching flow fires and
      // applies the fixed charge target to the car.
      await this.homey.flow.getTriggerCard('ems_set_car_target')
        .trigger(
          { target_soc: soc, car_name: carName, message: `${carName}: target charge ${soc}%` },
          { car_device_id: (car && car.device_id) || carId, target_pct: String(soc) },
        )
        .catch((e) => this.log(`[EMS] ems_set_car_target trigger failed: ${e.message}`));
    });

    this._applyPriceCurrencyUnit(this._getConfig());
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
    this._syncCarCapabilities(this._getConfig()).catch((e) => this.error('[EMS] car cap sync:', e.message));
    this._priceUnitApplied = null; // currency may have changed → re-apply unit next tick
    this._stopTick();
    this._startTick();
  }

  _onEnabledChanged() {
    // _tickBody handles both states (it sets 'disabled' when off); running a tick
    // keeps the mode decision on the single buffered path in _flushMode.
    this._tick().catch(() => {});
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
        targetReachedCar:  null, // carId whose charge target is reached (hold until unplug)
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
      await this._flushMode(); // apply exactly one mode decision per tick
    } catch (e) {
      this.log(`[EMS] tick error: ${e.message}`);
      this._tickMode = null; // drop a half-formed decision
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
    this._devCache = new Map(); // fresh device snapshot per tick (see _cap)

    // Electricity price is independent of solar control — update it every tick,
    // even when the EMS is disabled or has no API key.
    await this._applyPriceCurrencyUnit(cfg);
    await this._updatePriceCapability(cfg);
    await this._updateCarCapabilities(cfg);

    if (!enabled || !hasKey) {
      if (hasKey) {
        // Display-only refresh — chargers are not fetched: nothing controls them here
        const [gridW, pvW, battery] = await Promise.all([
          this._getGridW(cfg), this._getPvW(cfg), this._getBattery(cfg),
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
      } else {
        await this._setMode('error', 'Kein API-Schlüssel — bitte in den Geräteeinstellungen eintragen');
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
      houseW = await this._getHouseW(cfg, gridW, pvW, battery, chargers);
      if (houseW !== null) await this._set('measure_house_power', Math.round(houseW));
    }
    if (this._warmupDone) await this._checkBatteryTriggers(cfg, battery);
    if (this._warmupDone) await this._checkScheduler(cfg).catch((e) => this.error('[EMS] scheduler:', e.message));

    // ── Sensor failure guard ──────────────────────────────────────────────────
    // _getGridW returns null after GRID_SENSOR_HOLD_TICKS consecutive failures.
    // Hold all device control and report error; PV/battery display is still updated above.
    if (gridW === null) {
      const failSecs = this._gridSensorFail * Math.round(TICK_MS / 1000);
      await this._setMode('error', `Netzstrom-Sensor: ${failSecs}s kein Signal — EMS wartet`);
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

    // ── Mode/status for simple devices ────────────────────────────────────────
    // Without chargers the charger evaluation never runs, so mode/status is set
    // here. WITH chargers the charger evaluation owns the mode — but when it
    // left a passive state ('holding'/'idle') while e.g. the pool is running,
    // the running simple devices take over the display.
    const simpleDevicesAll = [...heatPumps, ...boilers, ...pools, ...dehumidifiers];
    const socStr = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
    const activeHpCount           = heatPumps.filter((d)     => this._heatPumpStates.get(d.id)?.isOn).length;
    const activeBoilerCount       = boilers.filter((d)       => this._boilerStates.get(d.id)?.isOn).length;
    const activePoolCount         = pools.filter((d)         => this._poolStates.get(d.id)?.isOn).length;
    const activeDehumidifierCount = dehumidifiers.filter((d) => this._dehumidifierStates.get(d.id)?.isOn).length;
    const activeCount             = activeHpCount + activeBoilerCount + activePoolCount + activeDehumidifierCount;
    // Pick mode matching the single active device type; fall back to solar_hp for mixed
    let simpleMode = 'solar_hp';
    if (!activeHpCount && activeBoilerCount && !activePoolCount && !activeDehumidifierCount) simpleMode = 'solar_boiler';
    else if (!activeHpCount && !activeBoilerCount && activePoolCount && !activeDehumidifierCount) simpleMode = 'solar_pool';
    else if (!activeHpCount && !activeBoilerCount && !activePoolCount && activeDehumidifierCount) simpleMode = 'solar_dehumidifier';
    const stTextActive = `${activeCount} Gerät${activeCount > 1 ? 'e' : ''} aktiv${socStr}`;

    if (!chargers.length && !simpleDevicesAll.length) {
      await this._setMode('not_configured', 'Konfiguriere EMS in App Settings');
    } else if (!chargers.length && simpleDevicesAll.length) {
      if (activeCount) {
        await this._setMode(simpleMode, stTextActive);
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
      }
    } else if (chargers.length && activeCount) {
      // Chargers configured but passive while simple devices run — reflect them
      const currentMode = this.getCapabilityValue('ems_mode');
      if (currentMode === 'holding' || currentMode === 'idle') {
        await this._setMode(simpleMode, stTextActive);
      }
    }
  }

  // ─── Device reads ──────────────────────────────────────────────────────────

  // Per-tick cached capability read. HomeyLocalApi.getCapability fetches the
  // ENTIRE device object per call — with 2 caps per charger/simple device that
  // doubled the HTTP load. Here each device is fetched exactly once per tick
  // (single consistent snapshot); the cache is cleared at the top of _tickBody.
  async _cap(deviceId, capId) {
    if (!this._devCache.has(deviceId)) {
      this._devCache.set(deviceId, this._api.getDevice(deviceId).catch(() => null));
    }
    const device = await this._devCache.get(deviceId);
    const capObj = device?.capabilitiesObj || device?.capabilities || {};
    const entry  = !Array.isArray(capObj) ? capObj[capId] : null;
    if (entry === null || entry === undefined) return null;
    return typeof entry === 'object' ? (entry.value ?? null) : entry;
  }

  async _persistExportLimit() {
    await this.setStoreValue('exportLimitState', {
      active:      this._exportLimitActive,
      activatedAt: this._exportLimitActivatedAt,
    }).catch(() => {});
  }

  async _getBattery(cfg) {
    const devices = cfg.battery_devices || [];
    if (!devices.length) return { soc: null, powerW: null, socPerDevice: {} };
    const [socs, powers] = await Promise.all([
      Promise.all(devices.map((d) => this._cap(d.id, d.cap_soc || 'measure_battery'))),
      Promise.all(devices.map((d) => d.cap_power ? this._cap(d.id, d.cap_power) : Promise.resolve(null))),
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

  async _getHouseW(cfg, gridW, pvW, battery, chargers = null) {
    const devices = cfg.house_devices || [];
    if (devices.length) {
      const vals  = await Promise.all(devices.map((d) =>
        this._cap(d.id, d.cap_power || 'measure_power'),
      ));
      const valid = vals.filter((v) => v !== null && v >= 0);
      return valid.length ? valid.reduce((a, b) => a + b, 0) : null;
    }
    // Fallback: energy balance PV + grid − battery − chargers = house
    // Subtract charger consumption so the displayed house load doesn't include the EV charger.
    // Prefer the MEASURED charger power (already fetched this tick) over the amps×phases
    // estimate: a self-capping car draws less than requested, and overstating chargerW
    // understates houseW → the PV cross-check budget would over-allocate.
    if (gridW === null) return null;
    let chargerW = 0;
    if (Array.isArray(chargers) && chargers.length) {
      chargerW = chargers.reduce((s, c) => s + (c.rawPowerW ?? c.powerW ?? 0), 0);
    } else {
      for (const st of this._chargerStates.values()) {
        if (st.currentAmps != null && st.currentPhases != null) {
          chargerW += st.currentAmps * st.currentPhases * 230;
        }
      }
    }
    return Math.max(0, (pvW ?? 0) + gridW - (battery.powerW ?? 0) - chargerW);
  }

  async _getPvW(cfg) {
    const devices = cfg.inverter_devices || [];
    if (!devices.length) return null;
    const vals  = await Promise.all(devices.map((d) =>
      this._cap(d.id, d.cap_power || 'measure_power'),
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
      return this._cap(d.id, cap);
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
    this._lastValidGridW = result;
    this._gridSensorFail = 0;
    return result;
  }

  async _getChargers(cfg) {
    const cfgs = cfg.chargers || [];
    return Promise.all(cfgs.map(async (c) => {
      const capState = c.cap_state || 'evcharger_charging_state';
      const capPower = c.cap_power || 'measure_power';
      const [rawState, rawPowerW] = await Promise.all([
        this._cap(c.id, capState)
          .then((v) => v !== null ? v : this._cap(c.id, 'onoff')),
        this._cap(c.id, capPower),
      ]);
      const st = this._getChargerState(c.id);
      // When EMS has amps set, use estimated power as a floor — prevents false "no surplus"
      // stop during the startup lag where the charger reports 0 W but the grid meter already
      // sees the draw, collapsing budgetW to near zero.
      const estimatedW = st.currentAmps > 0
        ? st.currentAmps * (st.currentPhases ?? (parseInt(c.ev_phases) || 3)) * 230
        : 0;
      const powerW     = rawPowerW != null ? Math.max(rawPowerW, estimatedW) : estimatedW;
      // rawPowerW is kept separately for the house-load energy balance, where the
      // estimate floor would overstate a self-capping car's real draw.
      // "connected" = car is physically plugged in (Easee: plugged_in_paused / ready_to_charge / car_connected / completed / charging)
      const DISCONNECTED_STATES = new Set(['standby', 'plugged_out', 'unplugged', 'available', 'idle', null, undefined, false]);
      const connected  = !DISCONNECTED_STATES.has(rawState);
      return {
        id:          c.id,
        maxAmps:     parseInt(c.max_amps,  10) || 16,
        minAmps:     parseInt(c.min_amps,  10) || AMPS_LADDER[0],
        connected,
        powerW,
        rawPowerW,
        phases:      parseInt(c.ev_phases, 10) || 3,
        phaseSwitch: c.phase_switch === true,
        // 'solar' (default) | 'solar_offpeak' | 'always'
        chargeMode:  c.charge_mode || 'solar',
      };
    }));
  }

  async _getSimpleDevices(devicesKey, cfg) {
    const cfgs = cfg[devicesKey] || [];
    return Promise.all(cfgs.map(async (c) => {
      const stateFromPower = c.state_from_power === true;
      const [powerW, onoff] = await Promise.all([
        c.cap_power ? this._cap(c.id, c.cap_power) : Promise.resolve(null),
        // Skip the onoff read entirely when state is derived from power
        stateFromPower ? Promise.resolve(null) : this._cap(c.id, 'onoff'),
      ]);
      const minPowerW = Number(c.min_power_w) || 0;
      // actualOn: the device's real on/off state as the EMS sees it.
      //   - onoff mode: the device's onoff capability (null → unknown, drift skipped)
      //   - power mode: power ≥ threshold. For devices whose plug is always on and
      //     where start/stop toggle an internal load (pool heater+filter), onoff
      //     never changes — power is the only real signal. Threshold = min_power_w
      //     if set, else 50 W. null (no power reading) → unknown, drift skipped.
      let actualOn;
      if (stateFromPower) {
        const thr = minPowerW > 0 ? minPowerW : 50;
        actualOn  = powerW != null ? (powerW >= thr) : null;
      } else {
        actualOn  = typeof onoff === 'boolean' ? onoff : null;
      }
      return {
        id:                  c.id,
        name:                c.name || c.id.slice(0, 8),
        powerW,
        onoff,
        actualOn,
        stateFromPower,
        minSurplusW:         Number(c.min_surplus_w)         || 2000,
        minPowerW,
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
    else { st.startedAt = null; st.lastEmsStopAt = Date.now(); }
    st.isOn = on;
    this._postNotification(`EMS: ${name} ${on ? 'gestartet' : 'gestoppt'}`);
    this._addHistoryEvent('device', on ? 'start' : 'stop', name, id);
    const card = on ? startCard : stopCard;
    this.log(`[EMS] ${tokenName} ${id}: ${on ? 'start' : 'stop'} → trigger ${card}`);
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
        const startGraceActive = st.startedAt && (now - st.startedAt) < 60_000;
        if (!device.actualOn && st.isOn && !startGraceActive) {
          this.log(`[EMS] ${tokenName} ${device.id}: external OFF detected — adopting state`);
          this._addHistoryEvent('device', 'manual_off', device.name, device.id);
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
              this._addHistoryEvent('device', 'manual_on', device.name, device.id);
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
  }

  // ─── Charger control ──────────────────────────────────────────────────────

  async _chargerStop(id) {
    this.log(`[EMS] charger ${id}: stop`);
    this._addHistoryEvent('charger', 'stop', '0A', id);
    this.log(`[EMS] charger ${id}: stop → trigger ems_set_charger_current (0A)`);
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
      this.log(`[EMS] charger ${id}: → trigger ems_start_charger`);
      await this.homey.flow
        .getTriggerCard('ems_start_charger')
        .trigger({ charger_device_id: id }, { charger_device_id: id })
        .catch((e) => this.log(`[EMS] charger ${id}: start trigger failed: ${e.message}`));
    }

    const p1 = amps;
    const p2 = phases >= 2 ? amps : 0;
    const p3 = phases >= 3 ? amps : 0;
    const prevAmps = st.currentAmps;
    if (prevAmps === null || prevAmps !== amps) {
      this._addHistoryEvent('charger', prevAmps === null ? 'start' : 'set_amps', `${amps}A/${phases}ph`, id);
    }
    this.log(`[EMS] charger ${id}: ${amps}A / ${phases}ph (L1=${p1} L2=${p2} L3=${p3}) → trigger ems_set_charger_current`);
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

    let anyConnected = chargers.some((c) => c.connected);
    let totalW       = chargers.reduce((s, c) => s + c.powerW, 0);

    // ── P0: Instant charging ─────────────────────────────────────────────────
    if (this.getCapabilityValue('charge_now') === true) {
      if (!anyConnected) {
        const p0SocStr = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
        await this._setMode('idle', `kein EV verbunden${p0SocStr}`);
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
      return chargers.filter((c) => c.connected).reduce((s, c) => s + c.maxAmps * c.phases * 230, 0);
    }

    // ── P0.5: "Always charge" mode ───────────────────────────────────────────
    // Charges at max power as soon as the cable is in — independent of solar and
    // battery state (same standing as instant charging). These chargers are then
    // removed from the solar/off-peak logic below.
    let alwaysW = 0;
    const alwaysChargers = chargers.filter((c) => c.chargeMode === 'always');
    if (alwaysChargers.length) {
      for (const c of alwaysChargers) {
        const st = this._getChargerState(c.id);
        if (!c.connected) {
          if (st.currentAmps !== null) await this._chargerStop(c.id);
          continue;
        }
        if (this._warmupDone && (st.currentAmps !== c.maxAmps || st.currentPhases !== c.phases)) {
          await this._chargerSetAmps(c.id, c.maxAmps, c.phases);
        }
        alwaysW += c.maxAmps * c.phases * 230;
      }
      chargers = chargers.filter((c) => c.chargeMode !== 'always');
      if (!chargers.length) {
        const connAlways = alwaysChargers.filter((c) => c.connected);
        if (!connAlways.length) {
          const aSocStr = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
          await this._setMode('idle', `kein EV verbunden${aSocStr}`);
          return 0;
        }
        const aParts = connAlways.map((c) => `${c.maxAmps}A/${c.phases}ph`).join(' + ');
        await this._setMode('instant_ev', `Immer laden · ${aParts}`);
        return alwaysW;
      }
      // Recompute for the remaining (solar-managed) chargers
      anyConnected = chargers.some((c) => c.connected);
      totalW       = chargers.reduce((s, c) => s + c.powerW, 0);
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
          return alwaysW;
        }
        batOverflowMode = true;
      }
    }

    // ── P2: No EV connected ──────────────────────────────────────────────────
    if (!anyConnected) {
      this._importSince = null;
      for (const c of chargers) {
        const st = this._getChargerState(c.id);
        st.targetReachedCar = null; // cable out → clear the "target reached" hold
        if (st.currentAmps !== null) await this._chargerStop(c.id);
      }
      const idleSocStr      = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
      const idleSurplusW    = gridW !== null ? Math.round(-gridW) : null;
      const idleSurplusStr  = idleSurplusW !== null && idleSurplusW > 0
        ? `${idleSurplusW} W Überschuss${idleSocStr}`
        : `kein Überschuss${idleSocStr}`;
      await this._setMode('idle', idleSurplusStr);
      return alwaysW;
    }

    // ── P2.5: Charge target reached ──────────────────────────────────────────
    // The car is still plugged in but already at its configured target. Without
    // this the EMS keeps re-tuning amps against a car that no longer draws —
    // for the whole afternoon, as long as surplus exists. Hold until the cable
    // is unplugged (cleared in P2 above) or the target is raised.
    const chargingCar = this._pickChargingCar();
    if (chargingCar && chargingCar.soc !== null && chargingCar.target !== null) {
      for (const c of chargers) {
        const st = this._getChargerState(c.id);
        if (chargingCar.soc >= chargingCar.target) {
          if (st.targetReachedCar !== chargingCar.id) {
            this.log(`[EMS] charger ${c.id}: "${chargingCar.name}" reached target ${chargingCar.target}% (now ${chargingCar.soc}%) — holding until unplug`);
            this._addHistoryEvent('charger', 'target_reached', `${chargingCar.name} ${chargingCar.soc}% ≥ ${chargingCar.target}%`, c.id);
          }
          st.targetReachedCar = chargingCar.id;
        } else if (chargingCar.soc < chargingCar.target - 2) {
          st.targetReachedCar = null; // target raised or battery drained → resume
        }
      }
    }
    const connectedForTarget = chargers.filter((c) => c.connected);
    if (connectedForTarget.length
      && connectedForTarget.every((c) => this._getChargerState(c.id).targetReachedCar)) {
      for (const c of connectedForTarget) {
        if (this._getChargerState(c.id).currentAmps !== null) await this._chargerStop(c.id);
      }
      const tSocStr = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
      const stTextTarget = chargingCar
        ? `${chargingCar.name}: Ladeziel erreicht (${Math.round(chargingCar.soc)}% ≥ ${Math.round(chargingCar.target)}%) — wartet auf Abstecken${tSocStr}`
        : `Ladeziel erreicht — wartet auf Abstecken${tSocStr}`;
      await this._setMode('holding', stTextTarget);
      return alwaysW;
    }

    // ── P3: Off-peak ──────────────────────────────────────────────────────────
    const offpeakWin = this._offpeakWindow(cfg);
    // Off-peak applies to chargers in "Solar & tariff-optimised" mode. The global
    // offpeak_enabled tile toggle still works as a legacy/global enable.
    const offpeakChargers = chargers.filter((c) => c.connected
      && (c.chargeMode === 'solar_offpeak' || this.getCapabilityValue('offpeak_enabled') === true));
    if (!batOverflowMode && !batReserveMode && offpeakChargers.length && offpeakWin.active) {
      // Solar-first: if there's enough export surplus to cover the minimum step,
      // let the solar logic handle it — free energy outranks cheap grid energy.
      const solarFirst    = cfg.offpeak_solar_first !== false; // default true
      const solarCanClaim = solarFirst && gridW !== null && gridW <= -(MIN_CHARGE_W);

      if (!solarCanClaim) {
        this._importSince = null; // clear stale import timer so solar mode starts fresh after off-peak
        const opAmps = offpeakWin.amps;
        for (const c of offpeakChargers) {
          const opPhases = c.phaseSwitch ? 3 : c.phases;
          const st       = this._getChargerState(c.id);
          if (this._warmupDone && (st.currentAmps !== opAmps || st.currentPhases !== opPhases)) {
            await this._chargerSetAmps(c.id, opAmps, opPhases);
            if (c.phaseSwitch) st.lastPhaseSwitchAt = now;
          }
        }
        const n = offpeakChargers.length;
        const stTextOffpeak = `${opAmps}A × ${n} Lader`;
        await this._setMode('offpeak_ev', stTextOffpeak);
        return alwaysW + offpeakChargers.reduce((s, c) => s + opAmps * (c.phaseSwitch ? 3 : c.phases) * 230, 0);
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
      return alwaysW;
    } else {
      const parts  = active.map((s) => `${s.amps}A/${s.phases}ph`).join(' + ');
      const prefix = batOverflowMode ? 'Überschuss · ' : batReserveMode ? 'Reserve · ' : '';
      const stTextSolar = `${prefix}${parts}${active.length > 1 ? ` (${active.length} Lader)` : ''}${socStr}${batPwStr}`;
      await this._setMode('solar_ev', stTextSolar);
      return alwaysW + active.reduce((s, r) => s + r.allocatedW, 0);
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
    this.log(`[EMS] mode '${mode}' → trigger flow ${flowId}`);
    try { await this._api.triggerFlow(flowId); } catch (err) {
      this.log(`[EMS] mode '${mode}' flow ${flowId} failed: ${err.message}`);
    }
  }

  // ─── Scheduler ───────────────────────────────────────────────────────────

  async _checkScheduler(cfg) {
    const tasks = Array.isArray(cfg.scheduled_tasks) ? cfg.scheduled_tasks : [];
    if (!tasks.length) return;
    // Wall-clock time in the Homey timezone — Node runs UTC on Homey Pro, so
    // getHours()/getDay() would fire tasks 1–2 h off (same pattern as _offpeakWindow).
    const tz = this.homey.clock?.getTimezone?.() || 'UTC';
    if (!this._schedFmt || this._schedFmtTz !== tz) {
      this._schedFmt   = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      this._schedFmtTz = tz;
    }
    const now        = new Date();
    const parts      = Object.fromEntries(this._schedFmt.formatToParts(now).map((p) => [p.type, p.value]));
    const dayOfWeek  = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[parts.weekday] ?? now.getDay();
    const timeStr    = `${parts.hour}:${parts.minute}`;
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

  // ─── Electricity price ─────────────────────────────────────────────────────

  // Local wall-clock parts in the Homey timezone (Node runs UTC on Homey Pro).
  _priceWallClock() {
    const tz = this.homey.clock?.getTimezone?.() || 'UTC';
    if (!this._priceFmt || this._priceFmtTz !== tz) {
      this._priceFmt   = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      this._priceFmtTz = tz;
    }
    const parts     = Object.fromEntries(this._priceFmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    const dayOfWeek = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[parts.weekday] ?? new Date().getDay();
    const minutes   = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
    return { dayOfWeek, minutes };
  }

  // Returns the current price per kWh (number) or null when unknown.
  //   fixed    → price_fixed
  //   dual     → high_windows[today] decides high vs low (cross-midnight supported)
  //   variable → last value set via the ems_set_electricity_price flow
  _getCurrentPrice(cfg) {
    const pc   = cfg.price_config || {};
    const mode = pc.mode || 'fixed';
    if (mode === 'variable') return typeof this._variablePrice === 'number' ? this._variablePrice : null;
    if (mode === 'fixed')    return Number(pc.price_fixed) || 0;
    // dual tariff
    const { dayOfWeek, minutes } = this._priceWallClock();
    const win = (pc.high_windows || {})[dayOfWeek] || (pc.high_windows || {})[String(dayOfWeek)];
    let isHigh = false;
    if (win && win.start && win.end) {
      const s = this._parseTime(win.start);
      const e = this._parseTime(win.end);
      if (s !== null && e !== null) isHigh = s > e ? (minutes >= s || minutes < e) : (minutes >= s && minutes < e);
    }
    return isHigh ? (Number(pc.price_high) || 0) : (Number(pc.price_low) || 0);
  }

  // Sets the capability's unit label to "<currency>/kWh" (best-effort).
  async _applyPriceCurrencyUnit(cfg) {
    const currency = (cfg.price_config && cfg.price_config.currency) || 'CHF';
    if (this._priceUnitApplied === currency) return;
    this._priceUnitApplied = currency;
    try { await this.setCapabilityOptions('measure_electricity_price', { units: `${currency}/kWh` }); }
    catch (e) { /* older Homey without runtime options — value still shows */ }
  }

  async _updatePriceCapability(cfg) {
    const price = this._getCurrentPrice(cfg);
    if (price === null) return;
    const rounded = Math.round(price * 1000) / 1000;
    if (rounded !== this._lastPriceFired) {
      this._lastPriceFired = rounded;
      await this._set('measure_electricity_price', rounded);
    }
  }

  // ─── Cars ──────────────────────────────────────────────────────────────────
  // Each configured car gets its own sub-capabilities on the EMS device, both
  // read from the vehicle device (car.device_id):
  //   measure_car_soc.<carId>         — current SOC, from car.soc_capability
  //   measure_car_target_soc.<carId>  — target SOC, from car.target_soc_capability;
  //     falls back to the value set via the ems_set_car_target_soc flow when the
  //     vehicle exposes no target capability.
  async _updateCarCapabilities(cfg) {
    const cars = cfg.car_devices || [];
    const now  = Date.now();
    const states = [];
    for (const car of cars) {
      if (!car.id || !car.device_id) continue;
      const clamp = (v) => Math.round(Math.max(0, Math.min(100, Number(v))));

      let soc = null;
      if (car.soc_capability) {
        const v = await this._cap(car.device_id, car.soc_capability);
        if (v !== null && v !== undefined && Number.isFinite(Number(v))) soc = clamp(v);
        if (soc !== null && this.hasCapability(`measure_car_soc.${car.id}`)) {
          await this._set(`measure_car_soc.${car.id}`, soc);
        }
      }

      let tgt = null;
      if (car.target_soc_capability) {
        const v = await this._cap(car.device_id, car.target_soc_capability);
        if (v !== null && v !== undefined && Number.isFinite(Number(v))) tgt = clamp(v);
      }
      if (tgt === null && typeof this._carTargets[car.id] === 'number') tgt = clamp(this._carTargets[car.id]);
      if (tgt !== null && this.hasCapability(`measure_car_target_soc.${car.id}`)) {
        await this._set(`measure_car_target_soc.${car.id}`, tgt);
      }

      // Track SOC rises — used to tell WHICH car is currently being charged
      const prev = this._carSocTrack[car.id];
      if (soc !== null) {
        if (!prev) this._carSocTrack[car.id] = { soc, lastRiseAt: 0 };
        else {
          if (soc > prev.soc) prev.lastRiseAt = now;
          prev.soc = soc;
        }
      }
      states.push({ id: car.id, name: car.name || 'Car', soc, target: tgt });
    }
    this._carStates = states;
  }

  // The car most likely on the charger right now: the only configured one, or
  // the one whose SOC rose most recently (within 30 min).
  _pickChargingCar() {
    const states = this._carStates || [];
    if (!states.length) return null;
    if (states.length === 1) return states[0];
    let best = null; let bestAt = 0;
    for (const s of states) {
      const at = (this._carSocTrack[s.id] || {}).lastRiseAt || 0;
      if (at > bestAt) { bestAt = at; best = s; }
    }
    return (best && (Date.now() - bestAt) < 30 * 60_000) ? best : null;
  }

  // Adds/removes a capability so it only appears when relevant.
  async _ensureCap(id, want) {
    const has = this.hasCapability(id);
    if (want && !has)      await this.addCapability(id).catch((e) => this.error(`[EMS] addCapability ${id}:`, e));
    else if (!want && has) await this.removeCapability(id).catch(() => {});
  }

  // Per-car sub-capabilities exist only for configured cars; orphaned ones
  // (car deleted) are removed. Titles reflect the car name.
  async _syncCarCapabilities(cfg) {
    const cars    = cfg.car_devices || [];
    const wantSoc = new Set();  // capability ids that should exist
    const wantTgt = new Set();
    for (const car of cars) {
      if (!car.id || !car.device_id) continue;
      const socId = `measure_car_soc.${car.id}`;
      const tgtId = `measure_car_target_soc.${car.id}`;
      const hasSoc = !!car.soc_capability;
      // The target capability ALWAYS exists for a configured car: either read from
      // the vehicle (target_soc_capability) or held virtually in the EMS and set
      // via the "set car target charge" flow action.
      const virtualTarget = !car.target_soc_capability;
      // Seed a virtual target once so the tile shows a value the user can change
      if (virtualTarget && this._carTargets[car.id] == null) {
        this._carTargets[car.id] = 80;
        await this.setStoreValue('carTargets', this._carTargets).catch(() => {});
      }
      if (hasSoc) wantSoc.add(socId);
      wantTgt.add(tgtId);
      const label = car.name || 'Car';
      if (hasSoc) { await this._ensureCap(socId, true); await this._setCapTitle(socId, label); }
      await this._ensureCap(tgtId, true);
      await this._setCapTitle(tgtId, `${label} Target${virtualTarget ? ' (EMS)' : ''}`);
    }
    // Remove sub-capabilities of cars that no longer exist / lost their source
    for (const capId of this.getCapabilities()) {
      if (capId.startsWith('measure_car_soc.') && !wantSoc.has(capId))        await this._ensureCap(capId, false);
      if (capId.startsWith('measure_car_target_soc.') && !wantTgt.has(capId)) await this._ensureCap(capId, false);
    }
  }

  async _setCapTitle(capId, title) {
    try { await this.setCapabilityOptions(capId, { title }); } catch (e) { /* older Homey — default title */ }
  }

  // ─── State helpers ────────────────────────────────────────────────────────

  // Buffered: one tick may evaluate several device types, each proposing a mode
  // (e.g. the charger says "holding", the pool says "solar_pool"). Only the LAST
  // proposal of the tick is applied in _flushMode — otherwise the mode flaps back
  // and forth every tick, spamming history, the mode trigger and the mode flow.
  async _setMode(mode, newStatusText = null) {
    this._tickMode = { mode, text: newStatusText };
  }

  // Applies the tick's final mode: capability, trigger, mode flow and history.
  async _flushMode() {
    const m = this._tickMode;
    this._tickMode = null;
    if (!m) return;
    if (m.text != null) await this._set('ems_status_text', m.text);
    const prev = this.getCapabilityValue('ems_mode');
    await this._set('ems_mode', m.mode);
    if (!this._warmupDone) return; // first tick: observe only
    if (prev !== m.mode) {
      this.log(`[EMS] mode: ${prev ?? '—'} → ${m.mode} → trigger ems_mode_changed`);
      this.homey.flow.getDeviceTriggerCard('ems_mode_changed').trigger(this, { mode: m.mode }).catch(() => {});
      await this._triggerModeFlow(m.mode);
    }
    if (m.mode !== this._lastLoggedMode) {
      const label = m.text != null ? m.text : (this.getCapabilityValue('ems_status_text') || '');
      this._addHistoryEvent('mode', m.mode, label);
      this._lastLoggedMode = m.mode;
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
    for (const cap of ['ems_mode', 'ems_status_text', 'measure_solar_surplus', 'measure_pv_power', 'measure_house_power', 'measure_grid_power', 'measure_battery_power', 'measure_electricity_price', 'offpeak_enabled', 'charge_now']) {
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
  // Fires ems_inverter_export_limit_on / _off trigger cards automatically based on
  // battery SOC + grid export. Users link those triggers to inverter action cards.

  // Fires the on/off trigger for EVERY configured inverter (multi-inverter
  // installations throttle all of them, not just the first).
  async _fireExportLimitTrigger(cfg, cardId, logLabel) {
    const invIds = (cfg.inverter_devices || []).map((d) => d.id).filter(Boolean);
    for (const invId of invIds) {
      this.log(`[EMS] export limit ${logLabel} → trigger ${cardId} (inverter ${invId})`);
      await this.homey.flow.getTriggerCard(cardId)
        .trigger({ inverter_device_id: invId }, { inverter_device_id: invId })
        .catch((e) => this.log(`[EMS] export limit ${logLabel} trigger failed (${invId}): ${e.message}`));
    }
  }

  async _evaluateExportLimit(cfg, battery, gridW) {
    if (!cfg.export_limit_enabled) {
      // If the coordinator was just disabled while active, fire a deactivate to be safe
      if (this._exportLimitActive) {
        this._exportLimitActive      = false;
        this._exportLimitActivatedAt = null;
        await this._persistExportLimit();
        await this._fireExportLimitTrigger(cfg, 'ems_inverter_export_limit_off', 'OFF (disabled)');
      }
      return;
    }

    const trigSoc  = Number(cfg.export_limit_trigger_soc    ?? 95);
    const deactSoc = Number(cfg.export_limit_deactivate_soc ?? 90);
    const hasInv   = (cfg.inverter_devices || []).some((d) => d.id);

    if (!hasInv || battery.soc === null || gridW === null) return;

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
      await this._persistExportLimit();
      this.log(`[EMS] export limit ON — SOC ${Math.round(battery.soc)}% ≥ ${trigSoc}%, export ${Math.round(-gridW)}W`);
      this._addHistoryEvent('mode', 'export_limit_on', `SOC ${Math.round(battery.soc)}% · export ${Math.round(-gridW)}W`);
      await this._fireExportLimitTrigger(cfg, 'ems_inverter_export_limit_on', 'ON');
    } else if (shouldDeactivate) {
      this._exportLimitActive      = false;
      this._exportLimitActivatedAt = null;
      await this._persistExportLimit();
      this.log(`[EMS] export limit OFF — SOC ${Math.round(battery.soc)}% < ${deactSoc}% or no export`);
      this._addHistoryEvent('mode', 'export_limit_off', `SOC ${Math.round(battery.soc)}%`);
      await this._fireExportLimitTrigger(cfg, 'ems_inverter_export_limit_off', 'OFF');
    }
  }

}

module.exports = EmsDevice;
