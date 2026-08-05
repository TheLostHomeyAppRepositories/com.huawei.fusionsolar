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

  // Combines the PV (Solcast) forecast and the price status into one payload so the
  // widget only needs a single request per poll. Price follows whatever tariff model
  // is actually configured under App Settings → Electricity Price (fixed/variable/dual/
  // forecast) — see lib/ems/price.js#getEmsPriceStatus — not just the D10 forecast mode.
  async getForecast({ homey }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device', lang: lang(homey) };
    try {
      return {
        pv:    device.getPvForecast(),
        price: device.getEmsPriceStatus(),
        lang:  lang(homey),
      };
    } catch (e) {
      return { error: e.message, lang: lang(homey) };
    }
  },

};
