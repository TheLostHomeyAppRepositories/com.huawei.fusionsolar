'use strict';

const { getDevice, getDevices, cap, setting, capSum, capWeighted, isReachable, lang } = require('../../lib/widget-data');


// The batteries report their state in Huawei's English words — "Running", "Sleep mode",
// "Fault" — which the widget showed untranslated beside its own German "Laden". They go
// out as keys the widget translates (1.2.299). "Running" says nothing about which way the
// energy flows, so for that one the power decides, as it already did without a state.
const STATE_KEYS = {
  'offline': 'offline',
  'standby': 'standby',
  'fault': 'fault',
  'sleep mode': 'sleep',
  'hibernation': 'sleep',
  'initial power-on': 'starting',
  'power-off': 'off',
  'float charging': 'charging',
  'boost charging': 'charging',
  'charging': 'charging',
  'discharging': 'discharging',
  'testing': 'testing',
};

function direction(powerW) {
  if (powerW === null) return 'running';
  if (powerW > 50)  return 'charging';
  if (powerW < -50) return 'discharging';
  return 'standby';
}

function statusKey(raw, powerW) {
  if (raw === null || raw === undefined) return powerW === null ? null : direction(powerW);
  const k = String(raw).trim().toLowerCase();
  if (k === 'running') return direction(powerW);
  // A word not in the list ("Status 7" for an unknown code) goes out as it came.
  return STATE_KEYS[k] || String(raw);
}

module.exports = {
  statusKey,

  async getData({ homey }) {

    // Try luna2000_modbus → luna2000_emma_modbus → isitepower_battery
    // The FusionSolar OpenAPI battery was missing from this chain, so a plant reached only
    // through that cloud drew an empty widget. Local sources stay first: Modbus and the
    // EMMA gateway are seconds old, the cloud is minutes old at best.
    // Every LUNA2000 over Modbus, one per inverter: with two of them the widget showed the
    // first alone (Wim_Hartman, 2026-10-28). They stand in the chain as one battery, the first
    // that answers, and when they are the one shown their figures are taken together below.
    const lunas    = getDevices(homey, 'luna2000_modbus');
    const luna     = lunas.find(isReachable) || lunas[0] || null;
    const lunaEmma = getDevice(homey, 'luna2000_emma_modbus');
    const lunaOa   = getDevice(homey, 'luna2000_openapi_fusionsolar');
    const ispBatt  = getDevice(homey, 'isitepower_battery_openapi_fusionsolar');
    // The first battery that answers, not the first one paired. A Modbus LUNA that had
    // dropped off hid a cloud one that was fine, and a single unreachable battery read
    // "No battery" (1.2.300). When none answers the first paired one is still named, and
    // the widget says it is unreachable rather than that there is none.
    const paired   = [luna, lunaEmma, lunaOa, ispBatt].filter(Boolean);
    const device   = paired.find(isReachable) || paired[0] || null;
    const unreachable = !!device && !isReachable(device);

    // The Modbus batteries together: the powers and the day's energy add up, and the state of
    // charge and the three limits are weighted by capacity (capWeighted). With the ceiling,
    // floor and charge weighted alike, what the widget works out to full and to empty is
    // exactly the sum of what each battery has left. One battery reads as it always did.
    const together = device === luna && lunas.length > 1;
    const soc                = together ? capWeighted(lunas, (d) => cap(d, 'measure_battery', null))
                                        : cap(device, 'measure_battery', null);
    const powerW             = together ? capSum(lunas, 'measure_power') : cap(device, 'measure_power', null);
    const todayChargedKwh    = capSum(lunas, 'meter_power.today_batt_input')
                            ?? cap(lunaEmma, 'meter_power.today_batt_input', null)
                            ?? cap(lunaOa, 'meter_power.today_batt_input', null);
    const todayDischargedKwh = capSum(lunas, 'meter_power.today_batt_output')
                            ?? cap(lunaEmma, 'meter_power.today_batt_output', null)
                            ?? cap(lunaOa, 'meter_power.today_batt_output', null);

    // Status: prefer luna2000_battery_status, derive from power if not available. Two
    // batteries in different states have no one word between them, and the summed power
    // says which way the energy goes.
    const lunaStatuses = [...new Set(lunas.filter(isReachable)
      .map((d) => cap(d, 'luna2000_battery_status', null)).filter((v) => v !== null))];
    const rawStatus = (lunaStatuses.length === 1 ? lunaStatuses[0] : null)
                   ?? cap(lunaOa, 'luna2000_battery_status', null)    // since 1.2.281
                   ?? cap(lunaOa, 'openapi_battery_status', null)     // until the device has moved over
                   ?? cap(ispBatt, 'openapi_battery_status', null);
    const status = statusKey(rawStatus, powerW);

    // The nameplate capacity, straight from the battery (register 37758 on a LUNA2000),
    // so the remaining-time estimate no longer depends on somebody having typed the right
    // number into the widget's own settings. Null when the battery does not report one —
    // an EMMA battery, an OpenAPI plant — and null is an answer the widget knows how to
    // show: it shows no time at all rather than a confident wrong one.
    //
    // cap() returns null for an unreachable device unless the capability name starts with
    // meter_, which this one does not. That is right here: a battery nobody can reach
    // should not be counting down to anything.
    // Together only when every battery says its own: a sum missing one would count down to
    // a time that is not there.
    const reachableLunas = lunas.filter(isReachable);
    const capacities = reachableLunas.map((d) => cap(d, 'battery_rated_capacity', null));
    const capacityKwh = together
      ? (capacities.every((c) => typeof c === 'number') ? capSum(reachableLunas, 'battery_rated_capacity') : null)
      : (cap(device, 'battery_rated_capacity', null) ?? cap(device, 'isitepower_total_capacity', null));

    // Where the battery will actually stop, so the estimate can count to that instead of
    // to 0 % and 100 % — which it never reaches. Sent raw, one number each, because the
    // direction is decided in the widget from powerW and the arithmetic belongs beside it.
    //
    // Each is null on its own when this battery does not know it: a LUNA2000 over Modbus has
    // all three, an EMMA battery only the reserve, an OpenAPI plant none. They fall back one
    // by one, not as a set.
    const num = (v) => {
      const n = typeof v === 'string' ? parseFloat(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    };
    const socCeiling = together ? capWeighted(lunas, (d) => setting(d, 'charging_cutoff_capacity'))
                                : num(setting(device, 'charging_cutoff_capacity'));
    const socFloor   = together ? capWeighted(lunas, (d) => setting(d, 'discharge_cutoff_capacity'))
                                : num(setting(device, 'discharge_cutoff_capacity'));
    const socReserve = together ? capWeighted(lunas, (d) => cap(d, 'measure_battery.backup', null))
                                : num(cap(device, 'measure_battery.backup', null));

    // The EMMA battery says how many kWh are left to full and to empty — the estimate the
    // widget would otherwise have to build from a capacity somebody typed in. meter_*
    // names pass cap() even for a device that does not answer, so reachability is checked
    // here: a figure from an hour ago is not what is left now.
    const fresh = (v) => (lunaEmma && device === lunaEmma && isReachable(lunaEmma) ? v : null);
    const toFullKwh  = fresh(cap(lunaEmma, 'meter_power.chargeable_capacity', null));
    const toEmptyKwh = fresh(cap(lunaEmma, 'meter_power.dischargeable_capacity', null));

    return { soc, status, powerW, todayChargedKwh, todayDischargedKwh, capacityKwh,
      socCeiling, socFloor, socReserve, toFullKwh, toEmptyKwh, unreachable, paired: paired.length > 0,
      lang: lang(homey) };
  }
};
