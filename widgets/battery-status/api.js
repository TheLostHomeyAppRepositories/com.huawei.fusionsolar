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

    // Try luna2000_modbus first, fall back to luna2000_emma_modbus
    const luna     = getDevice(homey, 'luna2000_modbus');
    const lunaEmma = getDevice(homey, 'luna2000_emma_modbus');
    const device   = luna || lunaEmma;

    const soc                = cap(device, 'measure_battery', null);
    const powerW             = cap(device, 'measure_power', null);
    const todayChargedKwh    = cap(luna, 'meter_power.today_batt_input', null);
    const todayDischargedKwh = cap(luna, 'meter_power.today_batt_output', null);

    // Status: prefer luna2000_battery_status, derive from power if not available
    let status = cap(luna, 'luna2000_battery_status', null);
    if (status === null && powerW !== null) {
      if (powerW > 50)       status = 'Laden';
      else if (powerW < -50) status = 'Entladen';
      else                   status = 'Standby';
    }

    return { soc, status, powerW, todayChargedKwh, todayDischargedKwh };
  }
};
