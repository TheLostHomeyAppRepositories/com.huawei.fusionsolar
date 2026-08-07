'use strict';

function getEmsDevice(homey) {
  try {
    const driver  = homey.drivers.getDriver('energy_management');
    const devices = driver.getDevices();
    return devices.length > 0 ? devices[0] : null;
  } catch { return null; }
}

// The dashboard language comes from Homey itself, NOT from navigator.language inside the
// widget — that is the browser/OS language and can differ from the Homey app language
// (an English phone paired with a German Homey used to show English widgets). Returned
// with every payload so the view picks its translations from the authoritative source.
function lang(homey) {
  try { return homey.i18n.getLanguage() || 'en'; } catch (e) { return 'en'; }
}

module.exports = {

  async getDevices({ homey }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device', devices: [], lang: lang(homey) };
    try {
      return { devices: await device.getEmsControllableDevices(), lang: lang(homey) };
    } catch (e) {
      return { error: e.message, devices: [], lang: lang(homey) };
    }
  },

  async getStatus({ homey, query }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device', lang: lang(homey) };
    const id = query && query.device;
    if (!id) return { error: 'no_device_selected', lang: lang(homey) };
    try {
      return { ...(await device.getEmsControllableStatus(id)), lang: lang(homey) };
    } catch (e) {
      return { error: e.message, lang: lang(homey) };
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

  // POST /car-target — charge-limit buttons under the car bar.
  //
  // Must live here, not in the app's api.js: a widget's Homey.api() calls are routed to
  // its own api.js, so an app-level route is simply unreachable from the tile.
  async setCarTarget({ homey, body }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device' };
    const { carId, soc } = body || {};
    if (!carId) return { error: 'missing_car_id' };
    if (typeof device.setCarTargetSoc !== 'function') return { error: 'car_targets_unsupported' };
    try {
      return { ok: true, soc: await device.setCarTargetSoc(carId, soc) };
    } catch (e) {
      return { error: e.message };
    }
  },

  async setChargeNow({ homey, body }) {
    const device = getEmsDevice(homey);
    if (!device) return { error: 'no_ems_device' };
    const { chargeNow } = body || {};
    try {
      return await device.setEmsChargeNow(chargeNow);
    } catch (e) {
      return { error: e.message };
    }
  },

};
