'use strict';

const { getDevice, cap } = require('../../lib/widget-data');

module.exports = {
  async getData({ homey }) {

    // Try luna2000_modbus first, fall back to luna2000_emma_modbus
    const luna     = getDevice(homey, 'luna2000_modbus');
    const lunaEmma = getDevice(homey, 'luna2000_emma_modbus');
    const device   = luna || lunaEmma;

    const soc                = cap(device, 'measure_battery', null);
    const powerW             = cap(device, 'measure_power', null);
    const todayChargedKwh    = cap(luna, 'meter_power.today_batt_input', null)
                            ?? cap(lunaEmma, 'meter_power.today_batt_input', null);
    const todayDischargedKwh = cap(luna, 'meter_power.today_batt_output', null)
                            ?? cap(lunaEmma, 'meter_power.today_batt_output', null);

    // Status: prefer luna2000_battery_status, derive from power if not available
    let status = cap(luna, 'luna2000_battery_status', null);
    if (status === null && powerW !== null) {
      if (powerW > 50)       status = 'charging';
      else if (powerW < -50) status = 'discharging';
      else                   status = 'standby';
    }

    return { soc, status, powerW, todayChargedKwh, todayDischargedKwh };
  }
};
