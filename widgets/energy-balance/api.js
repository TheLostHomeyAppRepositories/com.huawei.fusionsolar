'use strict';

function getDevice(homey, driverId) {
  try {
    const driver = homey.drivers.getDriver(driverId);
    const devices = driver.getDevices();
    return devices.length > 0 ? devices[0] : null;
  } catch { return null; }
}

function cap(device, id, fallback = null) {
  if (!device) return fallback;
  try { return device.getCapabilityValue(id) ?? fallback; } catch { return fallback; }
}

module.exports = {
  async getData({ homey }) {

    const sun2000     = getDevice(homey, 'sun2000_modbus');
    const sun2000emma = getDevice(homey, 'sun2000_emma_modbus');
    const pmEmma      = getDevice(homey, 'powermeter_emma_modbus');
    const luna        = getDevice(homey, 'luna2000_modbus');
    const lunaEmma    = getDevice(homey, 'luna2000_emma_modbus');
    const lunaDevice  = luna || lunaEmma;

    // PV today
    const pvTodayKwh = cap(sun2000, 'meter_power.daily', null)
                    ?? cap(sun2000emma, 'meter_power.pv_daily', null)
                    ?? cap(sun2000emma, 'meter_power.daily', null);

    const gridExportKwh = cap(pmEmma, 'meter_power.exported_today', null);
    const gridImportKwh = cap(pmEmma, 'meter_power.imported_today', null);

    // Battery today
    const battChargedKwh    = cap(luna, 'meter_power.today_batt_input',  null);
    const battDischargedKwh = cap(luna, 'meter_power.today_batt_output', null);

    // Selfconsumption: PV energy used on-site (not exported)
    let selfConsumptionPct  = null;
    let selfConsumedKwh     = null;
    if (pvTodayKwh !== null && pvTodayKwh > 0 && gridExportKwh !== null) {
      selfConsumedKwh     = Math.max(0, pvTodayKwh - gridExportKwh);
      selfConsumptionPct  = Math.round(selfConsumedKwh / pvTodayKwh * 100);
      selfConsumptionPct  = Math.max(0, Math.min(100, selfConsumptionPct));
    }

    // Autarkie: how much of total consumption was covered by PV
    let selfSufficiencyPct = null;
    if (selfConsumedKwh !== null && gridImportKwh !== null) {
      const totalConsumption = selfConsumedKwh + gridImportKwh;
      if (totalConsumption > 0) {
        selfSufficiencyPct = Math.round(selfConsumedKwh / totalConsumption * 100);
        selfSufficiencyPct = Math.max(0, Math.min(100, selfSufficiencyPct));
      }
    }

    // House consumption today = self-consumed PV + grid import
    let houseConsumptionKwh = null;
    if (selfConsumedKwh !== null && gridImportKwh !== null) {
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
