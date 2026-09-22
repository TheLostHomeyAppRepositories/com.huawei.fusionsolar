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
    // The FusionSolar OpenAPI battery was missing from this chain, so a plant reached only
    // through that cloud drew an empty widget. Local sources stay first: Modbus and the
    // EMMA gateway are seconds old, the cloud is minutes old at best.
    const luna     = getDevice(homey, 'luna2000_modbus');
    const lunaEmma = getDevice(homey, 'luna2000_emma_modbus');
    const lunaOa   = getDevice(homey, 'luna2000_openapi_fusionsolar');
    const ispBatt  = getDevice(homey, 'isitepower_battery_openapi_fusionsolar');
    const device   = luna || lunaEmma || lunaOa || ispBatt;

    const soc                = cap(device, 'measure_battery', null);
    const powerW             = cap(device, 'measure_power', null);
    const todayChargedKwh    = cap(luna, 'meter_power.today_batt_input', null)
                            ?? cap(lunaEmma, 'meter_power.today_batt_input', null)
                            ?? cap(lunaOa, 'meter_power.today_batt_input', null);
    const todayDischargedKwh = cap(luna, 'meter_power.today_batt_output', null)
                            ?? cap(lunaEmma, 'meter_power.today_batt_output', null)
                            ?? cap(lunaOa, 'meter_power.today_batt_output', null);

    // Status: prefer luna2000_battery_status, derive from power if not available
    let status = cap(luna, 'luna2000_battery_status', null)
              ?? cap(lunaOa, 'openapi_battery_status', null)
              ?? cap(ispBatt, 'openapi_battery_status', null);
    if (status === null && powerW !== null) {
      if (powerW > 50)       status = 'charging';
      else if (powerW < -50) status = 'discharging';
      else                   status = 'standby';
    }

    // The nameplate capacity, straight from the battery (register 37758 on a LUNA2000),
    // so the remaining-time estimate no longer depends on somebody having typed the right
    // number into the widget's own settings. Null when the battery does not report one —
    // an EMMA battery, an OpenAPI plant — and null is an answer the widget knows how to
    // show: it shows no time at all rather than a confident wrong one.
    //
    // cap() returns null for an unreachable device unless the capability name starts with
    // meter_, which this one does not. That is right here: a battery nobody can reach
    // should not be counting down to anything.
    const capacityKwh = cap(device, 'battery_rated_capacity', null)
                     ?? cap(device, 'isitepower_total_capacity', null);

    return { soc, status, powerW, todayChargedKwh, todayDischargedKwh, capacityKwh, lang: lang(homey) };
  }
};
