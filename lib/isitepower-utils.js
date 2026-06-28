'use strict';

const DEV_TYPE_AC_OUTPUT       = 60010;
const DEV_TYPE_BATTERY_RACK    = 60014;
const DEV_TYPE_SOLAR_GROUP     = 60043;
const DEV_TYPE_POWER_CONVERTER = 60092;

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function sum(maps, key) {
  const vals = maps.map((m) => num(m?.[key])).filter((v) => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

function avg(maps, key) {
  const vals = maps.map((m) => num(m?.[key])).filter((v) => v !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function firstOf(maps, keys, fn) {
  for (const key of keys) {
    const v = fn(maps, key);
    if (v !== null) return v;
  }
  return null;
}

function firstSumW(maps, keys) {
  const v = firstOf(maps, keys, sum);
  return v === null ? null : Math.round(v * 1000);
}

function firstAvg(maps, keys) {
  return firstOf(maps, keys, avg);
}

function firstSum(maps, keys) {
  return firstOf(maps, keys, sum);
}

function calculate(kpiByType) {
  const solarMaps    = kpiByType[DEV_TYPE_SOLAR_GROUP] || [];
  const batteryMaps  = kpiByType[DEV_TYPE_BATTERY_RACK] || [];
  const acMaps       = kpiByType[DEV_TYPE_AC_OUTPUT] || [];
  const convMaps     = kpiByType[DEV_TYPE_POWER_CONVERTER] || [];

  // Solar
  const solarGroupW  = firstSumW(solarMaps, ['total_output_power', 'mppt_power', 'active_power', 'output_power', 'pv_power']);
  const pvInputW     = firstSumW(convMaps, ['pv_input_power', 'input_power']);
  const solarCurrentA = firstSum(solarMaps, ['total_output_current', 'output_current']);
  const solarW       = solarGroupW ?? pvInputW ?? 0;

  // Battery
  const soc          = firstAvg(batteryMaps, ['soc', 'battery_soc', 'batterySOC']);
  const soh          = firstAvg(batteryMaps, ['soh', 'battery_soh']);
  const battSignedW  = firstSumW(batteryMaps, ['charge_discharge_power', 'ch_discharge_power', 'battery_power', 'active_power']);
  const chargeW      = battSignedW !== null ? Math.max(0, battSignedW) : 0;
  const dischargeW   = battSignedW !== null ? Math.max(0, -battSignedW) : 0;
  const battStatus   = firstAvg(batteryMaps, ['battery_state', 'battery_status', 'running_status', 'run_state']);
  const battVoltage  = firstAvg(batteryMaps, ['voltage', 'busbar_u']);
  const battCurrent  = firstSum(batteryMaps, ['current']);
  const totalDischargeKwh = firstSum(batteryMaps, ['total_discharge']);
  const totalCapacityKwh  = firstAvg(batteryMaps, ['total_capacity', 'rated_capacity']);
  const remainingBackupH  = firstAvg(batteryMaps, ['remaining_backup_time']);
  const dischargeCycles   = firstSum(batteryMaps, ['total_discharge_times']);

  // AC Output / Load
  const loadW        = firstSumW(acMaps, ['active_power', 'load_power', 'total_load_active_power', 'output_power']) ?? 0;
  const acVoltage    = firstAvg(acMaps, ['ac_voltage', 'voltage', 'meter_u', 'a_u']);
  const acCurrent    = firstOf(acMaps, ['ac_current', 'current', 'meter_i', 'a_i'], sum);
  const acFrequency  = firstAvg(acMaps, ['ac_frequency', 'frequency']);

  // Grid (calculated)
  const gridImportW  = Math.max(0, loadW + chargeW - solarW - dischargeW);

  return {
    solarW, solarGroupW, pvInputW, solarCurrentA,
    soc, soh, battSignedW, chargeW, dischargeW, battStatus,
    battVoltage, battCurrent, totalDischargeKwh, totalCapacityKwh, remainingBackupH, dischargeCycles,
    loadW, acVoltage, acCurrent, acFrequency,
    gridImportW,
  };
}

module.exports = {
  DEV_TYPE_AC_OUTPUT,
  DEV_TYPE_BATTERY_RACK,
  DEV_TYPE_SOLAR_GROUP,
  DEV_TYPE_POWER_CONVERTER,
  calculate,
};
