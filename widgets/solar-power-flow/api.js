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
    // Try sdongle_a_modbus first — has all 4 values directly
    const sdongle = getDevice(homey, 'sdongle_a_modbus');
    if (sdongle) {
      return {
        pvPower:      cap(sdongle, 'measure_power.solar', 0),
        gridPower:    cap(sdongle, 'measure_power.grid_active_power', 0),
        batteryPower: cap(sdongle, 'measure_power.battery', 0),
        housePower:   cap(sdongle, 'measure_power', 0),  // SDongle measure_power = load/house
      };
    }

    // Fallback: assemble from individual drivers
    const sun2000    = getDevice(homey, 'sun2000_modbus');
    const sun2000em  = getDevice(homey, 'sun2000_emma_modbus');
    const luna2000   = getDevice(homey, 'luna2000_modbus');
    const luna2000em = getDevice(homey, 'luna2000_emma_modbus');
    const pmEmma     = getDevice(homey, 'powermeter_emma_modbus');

    const pvPower      = cap(sun2000, 'measure_power',                  null)
                      ?? cap(sun2000em, 'measure_power',                 0);
    const gridPower    = cap(sun2000, 'measure_power.grid_active_power', null)
                      ?? cap(pmEmma,   'measure_power',                  0);
    const batteryPower = cap(luna2000, 'measure_power',                  null)
                      ?? cap(luna2000em, 'measure_power',                0);
    // house = PV + grid_import − battery_charge  (grid+= import, battery+= charging)
    const housePower   = Math.max(0, pvPower + gridPower - batteryPower);

    return { pvPower, gridPower, batteryPower, housePower };
  },
};
