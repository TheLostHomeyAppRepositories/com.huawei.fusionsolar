'use strict';

const { getDevice, cap } = require('../../lib/widget-data');

// Dashboard language from Homey itself, not navigator.language in the widget — that is
// the browser/OS language and can differ from the Homey app language. See
// widgets/ems-device/api.js for the full rationale.
function lang(homey) {
  try { return homey.i18n.getLanguage() || 'en'; } catch (e) { return 'en'; }
}

module.exports = {
  async getData({ homey }) {

    // Try luna2000_modbus → luna2000_emma_modbus → isitepower_battery
    const luna     = getDevice(homey, 'luna2000_modbus');
    const lunaEmma = getDevice(homey, 'luna2000_emma_modbus');
    const ispBatt  = getDevice(homey, 'isitepower_battery_openapi_fusionsolar');
    const device   = luna || lunaEmma || ispBatt;

    const soc                = cap(device, 'measure_battery', null);
    const powerW             = cap(device, 'measure_power', null);
    const todayChargedKwh    = cap(luna, 'meter_power.today_batt_input', null)
                            ?? cap(lunaEmma, 'meter_power.today_batt_input', null);
    const todayDischargedKwh = cap(luna, 'meter_power.today_batt_output', null)
                            ?? cap(lunaEmma, 'meter_power.today_batt_output', null);

    // Status: prefer luna2000_battery_status, derive from power if not available
    let status = cap(luna, 'luna2000_battery_status', null)
              ?? cap(ispBatt, 'openapi_battery_status', null);
    if (status === null && powerW !== null) {
      if (powerW > 50)       status = 'charging';
      else if (powerW < -50) status = 'discharging';
      else                   status = 'standby';
    }

    return { soc, status, powerW, todayChargedKwh, todayDischargedKwh, lang: lang(homey) };
  }
};
