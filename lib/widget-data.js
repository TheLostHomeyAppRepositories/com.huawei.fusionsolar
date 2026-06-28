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

  const pvPower      = cap(sun2000,    'measure_power',                  null)
                    ?? cap(sun2000em,  'measure_power',                  null)
                    ?? cap(sdongle,    'measure_power.solar',            null)
                    ?? cap(ispSolar,   'measure_power',                   0);
  const gridPower    = cap(sun2000,    'measure_power.grid_active_power', null)
                    ?? cap(pmEmma,     'measure_power',                   null)
                    ?? cap(sdongle,    'measure_power.grid_active_power', null)
                    ?? cap(ispGrid,    'measure_power',                   0);
  const batteryPower = cap(luna2000,   'measure_power',                  null)
                    ?? cap(luna2000em, 'measure_power',                  null)
                    ?? cap(sdongle,    'measure_power.battery',           null)
                    ?? cap(ispBatt,    'measure_power',                   null);
  const batterySoc   = cap(luna2000,   'measure_battery',                null)
                    ?? cap(luna2000em, 'measure_battery',                null)
                    ?? cap(ispBatt,    'measure_battery',                null);
  const housePower   = cap(ispHome,    'measure_power',                  null)
                    ?? Math.max(0, (pvPower ?? 0) + (gridPower ?? 0) - (batteryPower ?? 0));

  return { pvPower, gridPower, batteryPower, batterySoc, housePower };
}

module.exports = { getDevice, cap, getPowerData };
