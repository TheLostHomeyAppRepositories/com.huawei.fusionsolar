'use strict';

// Battery SOC zone helper. Mixed into EmsDevice.prototype; `this` is the device
// instance. Pure function of (cfg, battery) — kept as a mixin so it stays testable
// in isolation (see test/ems.test.js). Extracted from drivers/energy_management/device.js.

module.exports = {

  // Classifies the battery's state of charge into the EMS control zones:
  //   batHardStop — SOC below the low floor: controllable loads must go off (unless
  //                 an overflow exception applies at the call site).
  //   batReserve  — "orange" zone between the low floor and the normal minimum: loads
  //                 may run only on genuine surplus, not on battery power.
  // hasLowZone is true only when a distinct low floor (min_battery_soc_low) is
  // configured below the normal minimum. Without it, there is no reserve zone and
  // any SOC below min counts as a hard stop.
  _batteryZones(cfg, battery) {
    const minSoc     = Number(cfg.min_battery_soc     ?? 80);
    const minSocLow  = Number(cfg.min_battery_soc_low ?? 0);
    const hasLowZone = minSocLow > 0 && minSocLow < minSoc;
    const batLow      = battery.soc !== null && minSoc > 0 && battery.soc < minSoc;
    const batReserve = hasLowZone && battery.soc !== null
                       && battery.soc >= minSocLow && battery.soc < minSoc;
    const batHardStop = batLow && !batReserve;
    return { minSoc, minSocLow, hasLowZone, batLow, batReserve, batHardStop };
  },

  /**
   * Share of the solar surplus the devices may claim, as a fraction 0..1, ramped linearly
   * with battery SOC between two configured points. Replaces the flat orange watt budget:
   * the closer the battery is to the upper SOC, the more of the surplus goes to devices
   * and the less to charging.
   *
   * Returns null when the ramp is not configured, so callers keep the old zone behaviour —
   * this is opt-in, existing installs are untouched until they set the two SOC points.
   */
  _batterySurplusShare(cfg, soc) {
    const socLo = Number(cfg.share_soc_low  ?? 0);
    const socHi = Number(cfg.share_soc_high ?? 0);
    if (!(socHi > socLo) || soc === null || soc === undefined) return null;
    const pctLo = Number(cfg.share_pct_low  ?? 0)   / 100;
    const pctHi = Number(cfg.share_pct_high ?? 100) / 100;
    // Clamped, so below the lower point the devices get pctLo and above the upper one
    // pctHi — no extrapolation past either end.
    const t = Math.min(1, Math.max(0, (soc - socLo) / (socHi - socLo)));
    return Math.min(1, Math.max(0, pctLo + t * (pctHi - pctLo)));
  },

  /**
   * How much MORE than the current grid export the devices may draw, in watts — the same
   * currency as the flat orange budget it replaces, so the tick loop is unchanged.
   *
   * The share applies to PV minus house load, NOT to the raw PV reading: the house is
   * served first either way. And it cannot apply to the measured export, because the
   * export is already reduced by whatever the battery is absorbing — that absorbed power
   * is exactly what this budget lets a device claim instead.
   */
  _batteryShareBudgetW(cfg, soc, pvW, houseW, gridW) {
    const share = this._batterySurplusShare(cfg, soc);
    if (share === null || pvW === null || houseW === null || gridW === null) return null;
    const surplusW = Math.max(0, pvW - houseW);
    const exportW  = Math.max(0, -gridW);
    return Math.max(0, Math.round(surplusW * share - exportW));
  },

};
