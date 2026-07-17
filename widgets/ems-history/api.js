'use strict';

module.exports = {
  async getHistory({ homey }) {
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (!devices.length) return { events: [], error: 'No EMS device found' };
      const events = devices[0].getEmsHistory();
      return { events };
    } catch (e) {
      return { events: [], error: e.message };
    }
  },
};
