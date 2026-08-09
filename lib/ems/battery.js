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
  /**
   * One threshold, not three. Below the hard stop no device runs and the battery charges
   * at full power; above it the surplus share ramp (below) decides how much the devices
   * may take. The middle "reserve" zone with its flat watt budget is gone — the ramp
   * covers that ground continuously.
   *
   * Derived from the old settings rather than migrated, so nothing has to be rewritten in
   * storage: the old hard stop was minSocLow when a reserve zone existed, otherwise minSoc.
   *
   * The returned shape is unchanged on purpose. chargerControl reads five of these fields —
   * batReserve suppresses the grid-charging tiers, batLow enters the restricted mode,
   * hasLowZone picks the threshold — and with the reserve zone permanently absent they all
   * still say the right thing without that file having to change.
   */
  _batteryZones(cfg, battery) {
    const hardStop = Number(
      cfg.hard_stop_soc
      ?? (Number(cfg.min_battery_soc_low ?? 0) > 0 ? cfg.min_battery_soc_low : cfg.min_battery_soc)
      ?? 80,
    );
    const batHardStop = battery.soc !== null && hardStop > 0 && battery.soc < hardStop;
    return {
      minSoc: hardStop, minSocLow: hardStop,
      hasLowZone: false,          // no reserve zone any more
      batLow: batHardStop,        // "restricted" now means exactly "below the hard stop"
      batReserve: false,
      batHardStop,
    };
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
   * currency as the flat orange budget it replaced, so the tick loop is unchanged.
   *
   * The share applies to what the PV array is actually producing. Note what that means:
   * the house is served from the same production, so at a high house load a share of the
   * raw output can exceed what is genuinely free, and the difference is drawn from the
   * grid. That is deliberate — the whole-house grid import ceiling stays underneath as
   * the guard. Subtracting the current export is what keeps this a top-up rather than a
   * double count: the export is already reduced by whatever the battery is absorbing, and
   * that absorbed power is exactly what this budget lets a device claim instead.
   */
  _batteryShareBudgetW(cfg, soc, pvW, gridW) {
    const share = this._batterySurplusShare(cfg, soc);
    if (share === null || pvW === null || gridW === null) return null;
    const exportW = Math.max(0, -gridW);
    return Math.max(0, Math.round(Math.max(0, pvW) * share - exportW));
  },

};
