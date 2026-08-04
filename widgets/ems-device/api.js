'use strict';

function getEmsDevice(homey) {
  try {
    const driver  = homey.drivers.getDriver('energy_management');
    const devices = driver.getDevices();
    return devices.length > 0 ? devices[0] : null;
  } catch { return null; }
}

module.exports = {

  async getDevices({ homey }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device', devices: [] };
    try {
      return { devices: await device.getEmsControllableDevices() };
    } catch (e) {
      return { error: e.message, devices: [] };
    }
  },

  async getStatus({ homey, query }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device' };
    const id = query && query.device;
    if (!id) return { error: 'no_device_selected' };
    try {
      return await device.getEmsControllableStatus(id);
    } catch (e) {
      return { error: e.message };
    }
  },

  async setEnabled({ homey, body }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device' };
    const { device: id, enabled } = body || {};
    if (!id) return { error: 'missing_params' };
    try {
      return await device.setEmsDeviceEnabled(id, enabled);
    } catch (e) {
      return { error: e.message };
    }
  },

  async setMode({ homey, body }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device' };
    const { device: id, mode } = body || {};
    if (!id || !mode) return { error: 'missing_params' };
    try {
      return await device.setEmsChargerMode(id, mode);
    } catch (e) {
      return { error: e.message };
    }
  },

};
