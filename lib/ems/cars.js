'use strict';

// Wie lange ein bewusst gesetztes Ladeziel Vorrang vor dem Messwert des Fahrzeugs hat.
// Deckt den Weg Trigger -> Flow -> Auto -> Rueckmeldung ab; danach zaehlt wieder das, was
// das Fahrzeug tatsaechlich meldet — bleibt es beim alten Wert, sieht man das dann auch.
const CAR_TARGET_PIN_MS = 3 * 60 * 1000;

// EMS cars methods. Mixed into EmsDevice.prototype; `this` is the device
// instance. Extracted from drivers/energy_management/device.js.

module.exports = {

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

      // A target the user just set explicitly (widget button, flow action) wins over the
      // vehicle's own reading for a short while. Setting it only fires a trigger; the flow
      // then has to reach the car, and the car has to report the new limit back — until
      // that round trip completes the capability still holds the OLD value and would snap
      // the display straight back, making the button look broken.
      const setAt = this._carTargetSetAt && this._carTargetSetAt[car.id];
      const pinned = setAt && (Date.now() - setAt) < CAR_TARGET_PIN_MS
        && typeof this._carTargets[car.id] === 'number';

      let tgt = null;
      if (pinned) {
        tgt = clamp(this._carTargets[car.id]);
      } else {
        if (car.target_soc_capability) {
          const v = await this._cap(car.device_id, car.target_soc_capability);
          if (v !== null && v !== undefined && Number.isFinite(Number(v))) tgt = clamp(v);
        }
        if (tgt === null && typeof this._carTargets[car.id] === 'number') tgt = clamp(this._carTargets[car.id]);
      }
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
      // capacityKwh + readyBy feed the price-forecast deadline planner (D10, see
      // lib/ems/priceForecast.js _priceShouldChargeNow) — both optional.
      states.push({
        id: car.id, name: car.name || 'Car', soc, target: tgt,
        capacityKwh: Number(car.battery_capacity_kwh) || 0,
        readyBy: car.ready_by || null,
      });
    }
    this._carStates = states;
  },

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
  },

  // The car assigned to a specific charger. Prefers the explicit per-charger
  // mapping (charger.carId); otherwise falls back to the single-car case, or the
  // recent-SOC-rise heuristic when several cars exist without a mapping.
  _carForCharger(charger) {
    const states = this._carStates || [];
    if (!states.length) return null;
    if (charger && charger.carId) return states.find((s) => s.id === charger.carId) || null;
    if (states.length === 1) return states[0];
    return this._pickChargingCar();
  },

  // Adds/removes a capability so it only appears when relevant.
  async _ensureCap(id, want) {
    const has = this.hasCapability(id);
    if (want && !has)      await this.addCapability(id).catch((e) => this.error(`[EMS] addCapability ${id}:`, e));
    else if (!want && has) await this.removeCapability(id).catch(() => {});
  },

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
  },

  async _setCapTitle(capId, title) {
    if (!this._capTitlesApplied) this._capTitlesApplied = {};
    if (this._capTitlesApplied[capId] === title) return; // unchanged — skip the API call
    try {
      await this.setCapabilityOptions(capId, { title });
      this._capTitlesApplied[capId] = title;
    } catch (e) { /* older Homey — default title */ }
  },

};
