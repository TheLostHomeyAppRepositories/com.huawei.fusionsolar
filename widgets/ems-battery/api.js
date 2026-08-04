'use strict';

function getEmsDevice(homey) {
  try {
    const driver  = homey.drivers.getDriver('energy_management');
    const devices = driver.getDevices();
    return devices.length > 0 ? devices[0] : null;
  } catch { return null; }
}

module.exports = {

  async getStatus({ homey }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device' };
    try {
      return await device.getEmsBatteryStatus();
    } catch (e) {
      return { error: e.message };
    }
  },

  async setZones({ homey, body }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device' };
    try {
      return await device.setEmsBatteryZones(body || {});
    } catch (e) {
      return { error: e.message };
    }
  },

};
