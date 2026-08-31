'use strict';

/**
 * Shared helpers for all widget api.js files.
 *
 * Provides:
 *   getDevice(homey, driverId)  — safe driver/device lookup
 *   cap(device, id, fallback)   — safe capability value read
 *   getPowerData(homey)         — live power snapshot used by solar-power-flow & netzampel
 */

function getDevice(homey, driverId) {
  try {
    const driver = homey.drivers.getDriver(driverId);
    const devices = driver.getDevices();
    return devices.length > 0 ? devices[0] : null;
  } catch { return null; }
}

function cap(device, id, fallback = null) {
  if (!device) return fallback;
  try { return device.getCapabilityValue(id) ?? fallback; } catch { return fallback; }
}

/**
 * Returns live power data for the solar-power-flow and netzampel widgets.
 * Device priority: sun2000_modbus → sun2000_emma_modbus → sdongle_a_modbus
 *                  luna2000_modbus → luna2000_emma_modbus → sdongle_a_modbus
 *
 * @returns {{ pvPower, gridPower, batteryPower, batterySoc, housePower }}
 */
function getPowerData(homey) {
  const sun2000    = getDevice(homey, 'sun2000_modbus');
  const sun2000em  = getDevice(homey, 'sun2000_emma_modbus');
  const luna2000   = getDevice(homey, 'luna2000_modbus');
  const luna2000em = getDevice(homey, 'luna2000_emma_modbus');
  const pmEmma     = getDevice(homey, 'powermeter_emma_modbus');
  const sdongle    = getDevice(homey, 'sdongle_a_modbus');
  const ispSolar   = getDevice(homey, 'isitepower_solar_openapi_fusionsolar');
  const ispBatt    = getDevice(homey, 'isitepower_battery_openapi_fusionsolar');
  const ispGrid    = getDevice(homey, 'isitepower_grid_openapi_fusionsolar');
  const ispHome    = getDevice(homey, 'isitepower_home_openapi_fusionsolar');

  // Every chain ends in null, never 0 — "no device of this kind is paired" is not the
  // same statement as "it is producing nothing", and the widgets can say so: fmt() prints
  // null as an em dash. These two used to end in 0, which threw that away and drew a
  // confident "0 W" for a house that simply has no inverter or grid meter attached.
  const pvPower      = cap(sun2000,    'measure_power',                  null)
                    ?? cap(sun2000em,  'measure_power',                  null)
                    ?? cap(sdongle,    'measure_power.solar',            null)
                    ?? cap(ispSolar,   'measure_power',                   null);
  const gridPower    = cap(sun2000,    'measure_power.grid_active_power', null)
                    ?? cap(pmEmma,     'measure_power',                   null)
                    ?? cap(sdongle,    'measure_power.grid_active_power', null)
                    ?? cap(ispGrid,    'measure_power',                   null);
  const batteryPower = cap(luna2000,   'measure_power',                  null)
                    ?? cap(luna2000em, 'measure_power',                  null)
                    ?? cap(sdongle,    'measure_power.battery',           null)
                    ?? cap(ispBatt,    'measure_power',                   null);
  const batterySoc   = cap(luna2000,   'measure_battery',                null)
                    ?? cap(luna2000em, 'measure_battery',                null)
                    ?? cap(ispBatt,    'measure_battery',                null);
  // Derived only where there is something to derive from. The `?? 0` inside the sum would
  // otherwise turn two unknowns into a confident 0 W of house load — the same mistake as
  // above, one line further on. A missing battery is fine (a house without one draws the
  // difference), but without PV or grid the balance is not incomplete, it is unknown.
  const derivedHouse = (pvPower === null || gridPower === null)
    ? null
    : Math.max(0, pvPower + gridPower - (batteryPower ?? 0));
  const housePower   = cap(ispHome,    'measure_power',                  null) ?? derivedHouse;

  return { pvPower, gridPower, batteryPower, batterySoc, housePower };
}

module.exports = { getDevice, cap, getPowerData };
