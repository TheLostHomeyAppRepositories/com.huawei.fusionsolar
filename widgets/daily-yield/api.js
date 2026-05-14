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

    // Try sun2000_modbus then sun2000_emma_modbus
    const sun2000     = getDevice(homey, 'sun2000_modbus');
    const sun2000emma = getDevice(homey, 'sun2000_emma_modbus');

    const dailyKwh        = cap(sun2000, 'meter_power.daily', null)
                         ?? cap(sun2000emma, 'meter_power.daily', null);
    const totalKwh        = cap(sun2000, 'meter_power', null)
                         ?? cap(sun2000emma, 'meter_power', null);
    const optimizerTotal  = cap(sun2000, 'optimizer_total_count', null);
    const optimizerOnline = cap(sun2000, 'optimizer_online_count', null);

    // CO₂ erspart: Deutscher Strommix Ø 401 g/kWh (Umweltbundesamt 2023)
    const co2SavedKg = dailyKwh !== null
      ? Math.round(dailyKwh * 0.401 * 10) / 10
      : null;

    return { dailyKwh, totalKwh, optimizerTotal, optimizerOnline, co2SavedKg };
  },
};
