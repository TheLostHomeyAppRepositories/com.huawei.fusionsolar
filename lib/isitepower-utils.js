'use strict';

const DEV_TYPE_MAINS          = 60001;
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

// freshKpiByType: only types with live API data this poll (no stale cache).
// Used for the energy balance (grid calculation) to avoid mismatch between stale
// load data and stale battery data from different poll cycles.
function calculate(kpiByType, freshKpiByType) {
  const fresh        = freshKpiByType || kpiByType;
  const mainsMaps    = kpiByType[DEV_TYPE_MAINS]          || [];
  const solarMaps    = kpiByType[DEV_TYPE_SOLAR_GROUP]    || [];
  const batteryMaps  = kpiByType[DEV_TYPE_BATTERY_RACK]   || [];
  const acMaps       = kpiByType[DEV_TYPE_AC_OUTPUT]      || [];
  const convMaps     = kpiByType[DEV_TYPE_POWER_CONVERTER] || [];

  // Fresh-only maps — used for energy balance to prevent stale data mismatch
  const acMapsFresh   = fresh[DEV_TYPE_AC_OUTPUT]      || [];
  const battMapsFresh = fresh[DEV_TYPE_BATTERY_RACK]   || [];

  // Solar
  const solarGroupW   = firstSumW(solarMaps, ['total_output_power', 'mppt_power', 'active_power', 'output_power', 'pv_power']);
  const pvInputW      = firstSumW(convMaps, ['pv_input_power', 'input_power']);
  const solarCurrentA = firstSum(solarMaps, ['total_output_current', 'output_current']);
  const solarW        = solarGroupW ?? pvInputW ?? 0;

  // Battery
  const soc           = firstAvg(batteryMaps, ['soc', 'battery_soc', 'batterySOC']);
  const soh           = firstAvg(batteryMaps, ['soh', 'battery_soh']);
  const battSignedW   = firstSumW(batteryMaps, ['charge_discharge_power', 'ch_discharge_power', 'battery_power', 'active_power']);
  const chargeW       = battSignedW !== null ? Math.max(0, battSignedW) : 0;
  const dischargeW    = battSignedW !== null ? Math.max(0, -battSignedW) : 0;
  const battStatusRaw = batteryMaps.map((m) => num(m?.battery_state ?? m?.battery_status ?? m?.running_status ?? m?.run_state)).filter((v) => v !== null);
  const battStatus    = battStatusRaw.length ? battStatusRaw[0] : null;
  const battVoltage   = firstAvg(batteryMaps, ['voltage', 'busbar_u']);
  const battCurrent   = firstSum(batteryMaps, ['current']);
  const totalDischargeKwh = firstSum(batteryMaps, ['total_discharge']);
  const totalCapacityKwh  = firstSum(batteryMaps, ['total_capacity', 'rated_capacity']);
  const remainingBackupH  = firstAvg(batteryMaps, ['remaining_backup_time']);
  const dischargeCycles   = firstSum(batteryMaps, ['total_discharge_times']);

  // AC Output / Load
  // loadW: null when no data so Home driver can preserve last-known value instead of showing 0W.
  // loadWFresh: for energy balance only.
  const loadFromAC      = firstSumW(acMaps, ['active_power', 'load_power', 'total_load_active_power', 'output_power']);
  const loadFromACFresh = firstSumW(acMapsFresh, ['active_power', 'load_power', 'total_load_active_power', 'output_power']);
  const convApparentKva = firstSum(convMaps, ['ac_output_apparent_power']);
  const loadFromConv    = convApparentKva !== null ? Math.round(convApparentKva * 1000) : null;
  const loadW           = loadFromAC ?? loadFromConv ?? null; // null = no data, caller must not set 0
  const loadWFresh      = loadFromACFresh ?? loadFromConv ?? 0;

  // Mains (60001) — direct grid meter readings.
  // These are the most reliable source: present even when 60010/60014/60043/60092 return nothing.
  const mainsActiveW   = firstSumW(mainsMaps, ['active_power']);        // W, signed (+ = import)
  const mainsTotalKwh  = firstSum(mainsMaps, ['total_energy_consumption']); // kWh cumulative import
  const mainsVoltage   = firstAvg(mainsMaps, ['ac_voltage']);
  const mainsCurrent   = firstOf(mainsMaps, ['ac_current'], sum);
  const mainsFrequency = firstAvg(mainsMaps, ['ac_frequency']);

  // AC params: load side (60010) preferred, power converter (60092) second, mains (60001) last resort
  const acVoltage   = firstAvg(acMaps, ['ac_voltage', 'voltage', 'meter_u', 'a_u'])
                   ?? firstAvg(convMaps, ['ac_output_voltage', 'inverter_voltage'])
                   ?? mainsVoltage;
  const acCurrent   = firstOf(acMaps, ['ac_current', 'current', 'meter_i', 'a_i'], sum)
                   ?? firstOf(convMaps, ['ac_output_current'], sum)
                   ?? mainsCurrent;
  const acFrequency = firstAvg(acMaps, ['ac_frequency', 'frequency'])
                   ?? firstAvg(convMaps, ['ac_output_frequency', 'inverter_frequency'])
                   ?? mainsFrequency;

  // Grid: use direct 60001 reading when available — eliminates phantom readings and energy-balance
  // errors that occur when 60010/60014/60043/60092 return stale data from mismatched poll cycles.
  // Fall back to energy balance only when 60001 has no data.
  let gridImportW;
  if (mainsActiveW !== null) {
    gridImportW = Math.max(0, mainsActiveW);
  } else {
    // Fallback energy balance using fresh data only
    const battSignedWFresh = firstSumW(battMapsFresh, ['charge_discharge_power', 'ch_discharge_power', 'battery_power', 'active_power']);
    let chargeWForGrid    = battSignedWFresh !== null ? Math.max(0, battSignedWFresh) : 0;
    let dischargeWForGrid = battSignedWFresh !== null ? Math.max(0, -battSignedWFresh) : 0;
    if (battSignedWFresh === null && convApparentKva !== null) {
      const convPvKw = firstSum(convMaps, ['pv_input_power']) ?? 0;
      dischargeWForGrid = Math.max(0, Math.round((convApparentKva - convPvKw) * 1000));
    }
    gridImportW = Math.max(0, loadWFresh + chargeWForGrid - solarW - dischargeWForGrid);
  }

  return {
    solarW, solarGroupW, pvInputW, solarCurrentA,
    soc, soh, battSignedW, chargeW, dischargeW, battStatus,
    battVoltage, battCurrent, totalDischargeKwh, totalCapacityKwh, remainingBackupH, dischargeCycles,
    loadW, acVoltage, acCurrent, acFrequency,
    gridImportW, mainsTotalKwh,
  };
}

module.exports = {
  DEV_TYPE_MAINS,
  DEV_TYPE_AC_OUTPUT,
  DEV_TYPE_BATTERY_RACK,
  DEV_TYPE_SOLAR_GROUP,
  DEV_TYPE_POWER_CONVERTER,
  calculate,
};
