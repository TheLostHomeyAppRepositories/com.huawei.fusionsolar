'use strict';

// Dashboard language from Homey itself, not navigator.language — see ems-device/api.js.
function lang(homey) {
  try { return homey.i18n.getLanguage() || 'en'; } catch (e) { return 'en'; }
}

module.exports = {
  async getHistory({ homey }) {
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (!devices.length) return { events: [], error: 'No EMS device found', lang: lang(homey) };
      const events = devices[0].getEmsHistory();
      return { events, lang: lang(homey) };
    } catch (e) {
      return { events: [], error: e.message, lang: lang(homey) };
    }
  },
};
