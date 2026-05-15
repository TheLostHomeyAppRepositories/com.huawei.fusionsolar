'use strict';

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

module.exports = {
  async getData({ homey }) {
    const sun2000    = getDevice(homey, 'sun2000_modbus');
    const sun2000em  = getDevice(homey, 'sun2000_emma_modbus');
    const luna2000   = getDevice(homey, 'luna2000_modbus');
    const luna2000em = getDevice(homey, 'luna2000_emma_modbus');
    const pmEmma     = getDevice(homey, 'powermeter_emma_modbus');
    const sdongle    = getDevice(homey, 'sdongle_a_modbus');

    const pvPower      = cap(sun2000,    'measure_power',                  null)
                      ?? cap(sun2000em,  'measure_power',                  null)
                      ?? cap(sdongle,    'measure_power.solar',             0);
    const gridPower    = cap(sun2000,    'measure_power.grid_active_power', null)
                      ?? cap(pmEmma,     'measure_power',                   null)
                      ?? cap(sdongle,    'measure_power.grid_active_power', 0);
    const batteryPower = cap(luna2000,   'measure_power',                  null)
                      ?? cap(luna2000em, 'measure_power',                  null)
                      ?? cap(sdongle,    'measure_power.battery',           null);
    const batterySoc   = cap(luna2000,   'measure_battery',                null)
                      ?? cap(luna2000em, 'measure_battery',                null);
    const housePower   = Math.max(0, pvPower + gridPower - (batteryPower ?? 0));

    return { pvPower, gridPower, batteryPower, batterySoc, housePower };
  },
};
