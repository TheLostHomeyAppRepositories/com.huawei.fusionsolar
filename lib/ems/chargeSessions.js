'use strict';

// Per-charger charging session tracking (energy + cost). Mixed into
// EmsDevice.prototype; `this` is the device instance. Works for every charging
// mode (solar/off-peak/price/low-tariff/always) — it just integrates the already
// tick-sampled charger power over time, independent of how/why the charger is on.
const { CHARGE_SESSIONS_MAX } = require('./constants');

module.exports = {

  async _restoreChargeSessions() {
    this._chargeSessions = [];
    try {
      const stored = await this.getStoreValue('chargeSessions');
      if (Array.isArray(stored)) this._chargeSessions = stored;
    } catch (e) { /* ignore */ }
  },

  _saveChargeSessions() {
    if (this._chargeSessions.length > CHARGE_SESSIONS_MAX) {
      this._chargeSessions.splice(0, this._chargeSessions.length - CHARGE_SESSIONS_MAX);
    }
    this.setStoreValue('chargeSessions', this._chargeSessions).catch(() => {});
  },

  // Called once per charger per tick (any charge mode) with the current tick's
  // dtMs (elapsed since the last tick, TICK_MS in production). A session runs from
  // "car connected" to "car disconnected"; energy/cost only accumulate on ticks
  // where the charger actually drew power, so pauses (no surplus, price waiting,
  // battery protection, …) within one plug-in period don't split it into several
  // sessions — matches how a user thinks of "last night's charge" as one session.
  _trackChargeSession(charger, cfg, dtMs, gridW) {
    const st = this._getChargerState(charger.id);

    if (charger.connected && !st.sessionActive) {
      st.sessionActive        = true;
      st.sessionStartedAt     = Date.now();
      st.sessionEnergyKwh     = 0;
      st.sessionCostSum       = 0;
      st.sessionCostedKwh     = 0; // only the energy for which a price was known — avg-price denominator
      st.sessionGridKwh       = 0; // the part drawn from the grid (see the split below)
      const car = this._carForCharger(charger);
      st.sessionCarName = (car && car.name) || null;
    }

    // Bill the MEASURED draw, not `powerW`: the latter carries an amps×phases estimate
    // floor (device.js _getChargers) that exists solely to stop a false "no surplus"
    // charger stop during startup lag. A car that self-caps below the commanded current
    // (tapering near full, or a 1-phase car on a 3-phase charger) really draws only
    // `rawPowerW` — billing the estimate instead inflated logged session kWh and cost by
    // up to ~3×. Same field, and the same reasoning, as the house-load energy balance in
    // device.js _getHouseW. Falls back to powerW only when the charger reports no power
    // capability at all, where the estimate is the sole figure available.
    const drawW = charger.rawPowerW ?? charger.powerW ?? 0;
    if (st.sessionActive && drawW > 0) {
      const kwh = (drawW / 1000) * (dtMs / 3600_000);
      st.sessionEnergyKwh += kwh;

      // Split the draw into grid and solar. The charger is treated as the marginal load:
      // whatever the house imports at this moment is attributed to it first, up to its own
      // draw. For an EV charger that is the honest reading — it is the load the EMS switched
      // on, so it is the one that pushed the meter into import. Import beyond its own draw
      // belongs to the rest of the house, not to the car.
      const importW = Math.max(0, (gridW === null || gridW === undefined) ? 0 : gridW);
      const gridKwh = (Math.min(drawW, importW) / 1000) * (dtMs / 3600_000);
      st.sessionGridKwh += gridKwh;

      // Only grid energy costs anything. Solar the car takes would otherwise have been
      // exported — not bought — so billing it made every sunny session look expensive.
      const price = this._getCurrentPrice(cfg);
      if (typeof price === 'number' && gridKwh > 0) {
        st.sessionCostSum   += gridKwh * price;
        st.sessionCostedKwh += gridKwh;
      }
    }

    if (!charger.connected && st.sessionActive) {
      this._finalizeChargeSession(charger, st, cfg);
      st.sessionActive = false;
    }
  },

  // Ignore sessions with negligible energy (e.g. a car briefly plugged in and out,
  // or a connection-state blip) — not worth cluttering the log.
  _finalizeChargeSession(charger, st, cfg) {
    if (st.sessionEnergyKwh < 0.05) return;
    const energyKwh = Math.round(st.sessionEnergyKwh * 100) / 100;
    const gridKwh   = Math.round((st.sessionGridKwh || 0) * 100) / 100;
    const pvKwh     = Math.round(Math.max(0, st.sessionEnergyKwh - (st.sessionGridKwh || 0)) * 100) / 100;
    const pvShare   = st.sessionEnergyKwh > 0
      ? Math.round((1 - (st.sessionGridKwh || 0) / st.sessionEnergyKwh) * 100) : null;
    const cost      = st.sessionCostedKwh > 0 ? Math.round(st.sessionCostSum * 100) / 100 : null;
    const avgPrice  = st.sessionCostedKwh > 0 ? Math.round((st.sessionCostSum / st.sessionCostedKwh) * 1000) / 1000 : null;
    const currency  = (cfg.price_config && cfg.price_config.currency) || 'CHF';
    this._chargeSessions.push({
      chargerId: charger.id, carName: st.sessionCarName || null,
      startedAt: st.sessionStartedAt, endedAt: Date.now(),
      energyKwh, gridKwh, pvKwh, pvShare, cost, avgPrice, currency,
    });
    this._saveChargeSessions();
    this.log(`[EMS] charger ${charger.id}: session ended — ${energyKwh} kWh` + (cost != null ? `, ${cost} ${currency} (avg ${avgPrice}/kWh)` : ''));
  },

  getEmsChargeSessions() {
    return (this._chargeSessions || []).slice(-CHARGE_SESSIONS_MAX).map((s) => ({ ...s })).reverse(); // newest first
  },

};
