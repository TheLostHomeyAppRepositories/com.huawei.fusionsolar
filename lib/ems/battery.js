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

};
