'use strict';

const { getDevice, cap } = require('../../lib/widget-data');

function todayStr(homey) {
  let tz = 'UTC';
  try { tz = homey.clock.getTimezone() || 'UTC'; } catch {}
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Compute today's delta for a cumulative capability.
 * Baseline is written by app.js at midnight; here we only read it.
 * Returns null if no baseline exists for today yet.
 */
function dailyDelta(homey, rawValue, settingKey) {
  if (rawValue === null || rawValue === undefined) return null;

  let stored = null;
  try { stored = homey.settings.get(settingKey); } catch {}

  if (!stored || stored.date !== todayStr(homey)) return null;

  return Math.max(0, rawValue - stored.baseline);
}

module.exports = {
  async getData({ homey }) {

    const sun2000     = getDevice(homey, 'sun2000_modbus');
    const sun2000emma = getDevice(homey, 'sun2000_emma_modbus');
    const pmEmma      = getDevice(homey, 'powermeter_emma_modbus');
    const luna        = getDevice(homey, 'luna2000_modbus');
    const lunaEmma    = getDevice(homey, 'luna2000_emma_modbus');

    // PV today
    const pvTodayKwh = cap(sun2000, 'meter_power.daily', null)
                    ?? cap(sun2000emma, 'meter_power.pv_daily', null)
                    ?? cap(sun2000emma, 'meter_power.daily', null);

    // Grid export today: prefer sun2000 cumulative delta, fall back to EMMA inverter or EMMA meter
    const rawExport = cap(sun2000, 'meter_power.grid_export', null)
                   ?? cap(sun2000emma, 'meter_power.grid_export', null);
    let gridExportKwh = dailyDelta(homey, rawExport, 'eb_grid_export_baseline')
                     ?? cap(pmEmma, 'meter_power.exported_today', null);

    // Grid import today: prefer sun2000 cumulative delta, fall back to EMMA inverter or EMMA meter
    const rawImport = cap(sun2000, 'meter_power.grid_import', null)
                   ?? cap(sun2000emma, 'meter_power.grid_import', null);
    let gridImportKwh = dailyDelta(homey, rawImport, 'eb_grid_import_baseline')
                     ?? cap(pmEmma, 'meter_power.imported_today', null);

    // Battery today
    const battChargedKwh    = cap(luna, 'meter_power.today_batt_input',  null)
                           ?? cap(lunaEmma, 'meter_power.today_batt_input',  null);
    const battDischargedKwh = cap(luna, 'meter_power.today_batt_output', null)
                           ?? cap(lunaEmma, 'meter_power.today_batt_output', null);

    // Self-consumption: PV energy used on-site (not exported)
    let selfConsumptionPct = null;
    let selfConsumedKwh    = null;
    if (pvTodayKwh !== null && pvTodayKwh > 0 && gridExportKwh !== null) {
      selfConsumedKwh    = Math.max(0, pvTodayKwh - gridExportKwh);
      selfConsumptionPct = Math.round(selfConsumedKwh / pvTodayKwh * 100);
      selfConsumptionPct = Math.max(0, Math.min(100, selfConsumptionPct));
    }

    // Self-sufficiency: how much of total consumption was covered by PV
    let selfSufficiencyPct = null;
    if (selfConsumedKwh !== null && gridImportKwh !== null) {
      const totalConsumption = selfConsumedKwh + gridImportKwh;
      if (totalConsumption > 0) {
        selfSufficiencyPct = Math.round(selfConsumedKwh / totalConsumption * 100);
        selfSufficiencyPct = Math.max(0, Math.min(100, selfSufficiencyPct));
      }
    }

    // House consumption today: prefer direct meter value, fall back to calculation
    let houseConsumptionKwh = cap(pmEmma, 'meter_power.consumption_today', null);
    if (houseConsumptionKwh === null && selfConsumedKwh !== null && gridImportKwh !== null) {
      houseConsumptionKwh = selfConsumedKwh + gridImportKwh;
    }

    return {
      pvTodayKwh,
      gridExportKwh,
      gridImportKwh,
      houseConsumptionKwh,
      battChargedKwh,
      battDischargedKwh,
      selfConsumptionPct,
      selfSufficiencyPct,
    };
  },
};
