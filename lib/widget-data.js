'use strict';

/**
 * Shared helpers for all widget api.js files.
 *
 * Provides:
 *   getDevice(homey, driverId)  — safe driver/device lookup
 *   getDevices(homey, driverId) — every device of a driver, for the drivers summed below
 *   cap(device, id, fallback)   — safe capability value read
 *   getPowerData(homey)         — live power snapshot used by solar-power-flow & netzampel
 */

function getDevice(homey, driverId) {
  try {
    const driver = homey.drivers.getDriver(driverId);
    const devices = driver.getDevices();
    return devices.length > 0 ? devices[0] : null;
  } catch { return null; }
}

/**
 * Every device of a driver, in pairing order; [] when there is none.
 *
 * For the two drivers whose devices are each one inverter or one battery, read on its own
 * unit ID: sun2000_modbus and luna2000_modbus. A plant with two of each — two SUN2000 with a
 * LUNA2000 apiece on unit IDs 1 and 2 (Wim_Hartman, 2026-10-28) — was drawn by every widget
 * as the first set alone, because getDevice() hands back the first device paired; the power
 * flow even worked out the house from one inverter's solar against the whole plant's grid.
 * Their figures are summed now (capSum, capWeighted).
 *
 * Not the EMMA drivers, whose one device already reads the plant's totals from the EMMA, nor
 * the OpenAPI inverter, which carries station figures — two of either would count the plant
 * twice. And one unit paired twice is one inverter: the second device for the same address,
 * port and unit ID is left out.
 */
function getDevices(homey, driverId) {
  let devices;
  try { devices = homey.drivers.getDriver(driverId).getDevices() || []; } catch { return []; }
  const seen = new Set();
  return devices.filter((d) => {
    const address = setting(d, 'address');
    if (address === null) return true;
    const key = `${address}:${setting(d, 'port')}:${setting(d, 'modbus_id')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A device Homey cannot reach still holds the values it last managed to read, and
// getCapabilityValue hands them back without a word. Every one of the twelve widgets read
// them that way, so a dashboard went on showing "47%, discharging at 2.3 kW" for a battery
// that had been unreachable for an hour. Homey marks the device itself as unavailable
// everywhere else; the widgets were the one place that hid it.
//
// So an unavailable device contributes nothing here, and the widgets draw what they
// already draw for a device that is not paired at all: an em dash. Nothing to change in
// twelve separate pages, and the fallback chains improve as a side effect — a value from
// an unreachable inverter no longer wins over a reachable one further down the chain.
//
// The exception is deliberate. A lifetime meter_* total is a running total, and the last
// one read is still the best known total: 1107.62 kWh lifetime stays the best answer while
// the device is quiet, whereas "discharging at 2.3 kW" stops being true the moment the
// reading stops arriving. Withholding lifetime totals would throw away information that is
// not stale in any meaningful sense.
//
// Day-scoped totals are not that, and used to be treated as though they were. A counter
// that resets at midnight says nothing about today once a device has been offline across
// one: "charged 8.4 kWh today" is yesterday's 8.4 kWh, drawn in the place today's figure
// belongs. That is the thing lib/openapi-coordinator.js refuses to do with its own cache —
// "an old number is indistinguishable from a measurement" — and this file was quietly doing
// it one directory away.
//
// It is not hypothetical. A plant reported in #28 has a battery that answers the
// FusionSolar API intermittently: two diagnostic captures in four days both found
// getDevRealKpi(type=39) returning zero devices while the inverter and the EMMA answered
// normally. The device goes unavailable, correctly — and its today_batt_input went on
// being drawn as today's charge.
//
// Withholding it costs a five-minute network blip a figure. That is the trade this file
// already makes everywhere else, and it is the honest one: a blank says "not known", while
// a stale number says nothing at all about its own age.
const DAY_SCOPED = /daily|today/i;

function isReachable(device) {
  if (!device) return false;
  try {
    // getAvailable is a device method; a plain object from a test or an older Homey without
    // it should not be treated as unreachable.
    return typeof device.getAvailable === 'function' ? device.getAvailable() !== false : true;
  } catch { return true; }
}

function cap(device, id, fallback = null) {
  if (!device) return fallback;
  const name = String(id);
  const survivesOffline = name.startsWith('meter_') && !DAY_SCOPED.test(name);
  if (!isReachable(device) && !survivesOffline) return fallback;
  try { return device.getCapabilityValue(id) ?? fallback; } catch { return fallback; }
}

/**
 * A device setting, or null.
 *
 * Two of the three limits a battery honours — the charge ceiling and the discharge floor —
 * are settings rather than capabilities: they are written to the inverter as well as read
 * from it, and a setting is where a value you can change belongs. A widget that wants to
 * know where the battery will actually stop therefore has to read both kinds.
 *
 * Unlike cap(), reachability is not checked. A setting is the last value synced from the
 * device and keeps its meaning while the device is briefly away — the same reasoning that
 * lets cap() pass meter_ readings through when a device is unreachable.
 */
function setting(device, id, fallback = null) {
  if (!device) return fallback;
  try {
    const value = device.getSetting(id);
    return value === undefined || value === null ? fallback : value;
  } catch { return fallback; }
}

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * The sum of a capability over several devices (getDevices), read through cap() — so a
 * device that cannot be reached is left out, as it is left out everywhere else here. Null
 * when not one has a value: nothing known is still not 0.
 */
function capSum(devices, id) {
  let sum = null;
  for (const d of devices) {
    const v = num(cap(d, id, null));
    if (v !== null) sum = (sum ?? 0) + v;
  }
  return sum;
}

/**
 * A percentage across several batteries, weighted by their rated capacity — what two
 * batteries hold together, not the mean of two numbers: 90 % of 5 kWh beside 30 % of 15 kWh
 * is 45 %, not 60 %. Where a battery does not say its capacity the plain mean is the best
 * left. `valueOf` gives a device's number, or null to leave it out — a capability or a
 * setting alike. Only reachable devices count: a setting would otherwise outlive the reading
 * it belongs beside.
 */
function capWeighted(devices, valueOf) {
  const parts = [];
  for (const d of devices) {
    if (!isReachable(d)) continue;
    const v = num(valueOf(d));
    if (v !== null) parts.push({ v, w: num(cap(d, 'battery_rated_capacity', null)) });
  }
  if (!parts.length) return null;
  if (parts.every((p) => p.w !== null && p.w > 0)) {
    const total = parts.reduce((s, p) => s + p.w, 0);
    return parts.reduce((s, p) => s + p.v * p.w, 0) / total;
  }
  return parts.reduce((s, p) => s + p.v, 0) / parts.length;
}

/**
 * The SUN2000 the grid meter is wired to. With several inverters, one has the meter; the
 * others say they have none, and the SUN2000 driver takes the meter's capabilities off them.
 * Pairing order says nothing about which one it is. The first device paired when none has
 * them, as before.
 *
 * The energy-balance widget and app.js's midnight baselines both read the grid counters
 * from this one device — a baseline from one and a live value from another would make a
 * nonsense day.
 */
function meterInverter(homey) {
  const all = getDevices(homey, 'sun2000_modbus');
  const has = (d) => { try { return d.hasCapability('measure_power.grid_active_power') === true; } catch { return false; } };
  return all.find(has) || all[0] || null;
}

/**
 * Returns live power data for the solar-power-flow and netzampel widgets.
 * Device priority: sun2000_modbus → sun2000_emma_modbus → sdongle_a_modbus
 *                  luna2000_modbus → luna2000_emma_modbus → sdongle_a_modbus
 *
 * @returns {{ pvPower, gridPower, batteryPower, batterySoc, housePower }}
 */
function getPowerData(homey) {
  // Summed over every inverter and battery paired over Modbus (getDevices); the grid is read
  // off the one inverter the meter is wired to.
  const sun2000s   = getDevices(homey, 'sun2000_modbus');
  const sun2000    = meterInverter(homey);
  const sun2000em  = getDevice(homey, 'sun2000_emma_modbus');
  const luna2000s  = getDevices(homey, 'luna2000_modbus');
  const luna2000em = getDevice(homey, 'luna2000_emma_modbus');
  const pmEmma     = getDevice(homey, 'powermeter_emma_modbus');
  const dtsu666    = getDevice(homey, 'dtsu666_modbus');
  const sdongle    = getDevice(homey, 'sdongle_a_modbus');
  // The three FusionSolar OpenAPI drivers were missing from every chain below. The
  // iSitePower ones were added at some point and these were passed over, so a plant reached
  // only through the FusionSolar cloud — no Modbus, no EMMA — drew four widgets full of em
  // dashes and looked, reasonably enough, broken.
  const sunOa      = getDevice(homey, 'sun2000_openapi_fusionsolar');
  const lunaOa     = getDevice(homey, 'luna2000_openapi_fusionsolar');
  const pmOa       = getDevice(homey, 'powermeter_openapi_fusionsolar');
  const ispSolar   = getDevice(homey, 'isitepower_solar_openapi_fusionsolar');
  const ispBatt    = getDevice(homey, 'isitepower_battery_openapi_fusionsolar');
  const ispGrid    = getDevice(homey, 'isitepower_grid_openapi_fusionsolar');
  const ispHome    = getDevice(homey, 'isitepower_home_openapi_fusionsolar');
  const kiosk      = getDevice(homey, 'fusionsolar_kiosk');

  // Every chain ends in null, never 0 — "no device of this kind is paired" is not the
  // same statement as "it is producing nothing", and the widgets can say so: fmt() prints
  // null as an em dash. These two used to end in 0, which threw that away and drew a
  // confident "0 W" for a house that simply has no inverter or grid meter attached.
  const pvPower      = capSum(sun2000s, 'measure_power')
                    ?? cap(sun2000em,  'measure_power',                  null)
                    ?? cap(sdongle,    'measure_power.solar',            null)
                    ?? cap(sunOa,      'measure_power',                   null)
                    ?? cap(ispSolar,   'measure_power',                   null)
                    // Last: the kiosk is minutes old, but a kiosk-only plant otherwise drew
                    // a power flow of nothing but dashes (1.2.300).
                    ?? cap(kiosk,      'measure_power',                   null);
  // The DTSU666 was missing here too, and for a narrower reason: the SUN2000 mirrors the
  // meter's reading in its own register, so a plant with both was served either way. A
  // plant with the meter paired and no Modbus inverter had no grid figure at all. Its
  // measure_power is already negated to the same convention as the rest of this chain —
  // positive is import.
  const gridPower    = cap(sun2000,    'measure_power.grid_active_power', null)
                    ?? cap(dtsu666,    'measure_power',                   null)
                    ?? cap(pmEmma,     'measure_power',                   null)
                    // The EMMA and cloud inverters carry the grid reading too, in the same
                    // convention (+ import). An EMMA plant without its meter device paired
                    // read "no grid data" while the inverter beside it had the figure (1.2.300).
                    ?? cap(sun2000em,  'measure_power.grid_active_power', null)
                    ?? cap(sdongle,    'measure_power.grid_active_power', null)
                    ?? cap(pmOa,       'measure_power',                   null)
                    ?? cap(sunOa,      'measure_power.grid_active_power', null)
                    ?? cap(ispGrid,    'measure_power',                   null);
  const batteryPower = capSum(luna2000s, 'measure_power')
                    ?? cap(luna2000em, 'measure_power',                  null)
                    ?? cap(sdongle,    'measure_power.battery',           null)
                    ?? cap(lunaOa,     'measure_power',                   null)
                    ?? cap(ispBatt,    'measure_power',                   null);
  const batterySoc   = capWeighted(luna2000s, (d) => cap(d, 'measure_battery', null))
                    ?? cap(luna2000em, 'measure_battery',                null)
                    ?? cap(lunaOa,     'measure_battery',                null)
                    ?? cap(ispBatt,    'measure_battery',                null);
  // Derived only where there is something to derive from. The `?? 0` inside the sum would
  // otherwise turn two unknowns into a confident 0 W of house load — the same mistake as
  // above, one line further on. A missing battery is fine (a house without one draws the
  // difference), but without PV or grid the balance is not incomplete, it is unknown.
  const derivedHouse = (pvPower === null || gridPower === null)
    ? null
    : Math.max(0, pvPower + gridPower - (batteryPower ?? 0));
  const housePower   = cap(ispHome,    'measure_power',                  null) ?? derivedHouse;

  return { pvPower, gridPower, batteryPower, batterySoc, housePower };
}

// ── Shared by the widget api.js files (1.2.300) ─────────────────────────────────────────
// Each of the twelve used to carry its own copy of these.

/**
 * The dashboard language, from Homey itself — not navigator.language in the widget, which
 * is the browser/OS language and can differ from the Homey app language (an English phone
 * paired with a German Homey used to show English widgets). Returned with every payload so
 * the view picks its translations from the authoritative source.
 */
function lang(homey) {
  try { return homey.i18n.getLanguage() || 'en'; } catch (e) { return 'en'; }
}

/** The Energy Management device, or null. */
function getEmsDevice(homey) {
  return getDevice(homey, 'energy_management');
}

/** Today's date in the Homey timezone as YYYY-MM-DD — the key the midnight baselines carry. */
function todayStr(homey) {
  let tz = 'UTC';
  try { tz = homey.clock.getTimezone() || 'UTC'; } catch {}
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Today's part of a cumulative counter: the live value minus the baseline app.js stored at
 * midnight under settingKey. Null when there is no reading or no baseline for today yet.
 */
function dailyDelta(homey, rawValue, settingKey) {
  if (rawValue === null || rawValue === undefined) return null;
  let stored = null;
  try { stored = homey.settings.get(settingKey); } catch {}
  if (!stored || stored.date !== todayStr(homey)) return null;
  return Math.max(0, rawValue - stored.baseline);
}

/** The payload of the two live power widgets (solar-power-flow, netzampel). */
function powerPayload(homey) {
  return { ...getPowerData(homey), lang: lang(homey) };
}

module.exports = {
  getDevice, getDevices, cap, setting, capSum, capWeighted, meterInverter, getPowerData, isReachable,
  lang, getEmsDevice, todayStr, dailyDelta, powerPayload,
};
