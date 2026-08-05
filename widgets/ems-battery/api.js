'use strict';

function getEmsDevice(homey) {
  try {
    const driver  = homey.drivers.getDriver('energy_management');
    const devices = driver.getDevices();
    return devices.length > 0 ? devices[0] : null;
  } catch { return null; }
}

// Dashboard language from Homey itself, not navigator.language — see ems-device/api.js.
function lang(homey) {
  try { return homey.i18n.getLanguage() || 'en'; } catch (e) { return 'en'; }
}

module.exports = {

  async getStatus({ homey }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device', lang: lang(homey) };
    try {
      return { ...(await device.getEmsBatteryStatus()), lang: lang(homey) };
    } catch (e) {
      return { error: e.message, lang: lang(homey) };
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
