'use strict';

// Shared EMS constants. Extracted from drivers/energy_management/device.js so the
// device orchestrator and the lib/ems/* mixins reference one source of truth.
module.exports = {
  TICK_MS:                  15_000,       // default control-loop interval
  // Bounds for the configurable interval. Below 10 s the loop only re-reads the meters
  // more often without changing behaviour — nearly every decision is gated by hold timers
  // of 30 s and up. (Price, car SoC and PV forecast do not scale with it at all: they sit
  // behind SLOW_REFRESH_MS.) Above 60 s the battery floor and the import ceiling react too
  // late to be worth calling a safety limit.
  TICK_MIN_S:               10,
  TICK_MAX_S:               60,
  STEP_HOLD_MS:             30_000,
  IMPORT_HOLD_MS:           60_000,
  FLIP_COOLDOWN_MS:         5 * 60_000,
  SIMPLE_MIN_RUN_MS:        5 * 60_000,  // min run time for HP/boiler/pool before stop allowed
  SIMPLE_STATE_KEY:         'ems_simple_states', // simple-device timers, persisted across restarts
  // How long a stored state stays meaningful. An app update takes seconds and a Homey
  // reboot a few minutes; past this the timers describe a world that has moved on, so
  // the state is dropped and the devices are re-adopted from their actual on/off state.
  SIMPLE_STATE_MAX_GAP_MS:  10 * 60_000,
  EMS_HISTORY_MAX:          400,          // max history events kept in memory + settings
  CHARGE_SESSIONS_MAX:      200,          // max completed charge sessions kept in memory + settings
  PRICE_FORECAST_STALE_NOTIFY_MS: 48 * 60 * 60_000, // notify once when a previously-fed forecast has been stale this long
  PHASE_SWITCH_COOLDOWN_MS: 10 * 60_000,
  // Everything below is wall-clock, deliberately. These used to be counted in ticks, which
  // silently tied their meaning to the tick length: at a 60 s interval "4 ticks" of stale
  // grid data would be four minutes of controlling on a dead sensor, and nobody would
  // connect that to a setting called "tick interval".
  GRID_SENSOR_HOLD_MS:      60_000,       // keep using the last valid gridW this long on sensor failure
  SLOW_REFRESH_MS:          60_000,       // price / car SoC / PV forecast refresh cadence
  HISTORY_SAVE_MS:          5 * 60_000,   // periodic history flush (charger events)
  // Upper bound for "time since the previous tick". A restart, a suspended Homey or a
  // stopped debugger must not book the whole gap as runtime into a single tick.
  TICK_MAX_DT_MS:           2 * 60_000,
  IMPORT_ACT_W:             200,
  EXPORT_GUARD_W:           200,
  UP_MARGIN_W:              250,
  MIN_3PH_W:                6 * 3 * 230,      // 4140 W — minimum viable 3-phase load
  AMPS_LADDER:              [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32],
  EXPORT_LIMIT_MIN_EXPORT_W: 100,          // export-limit coordinator: min. grid export (W) to count as "exporting"
  EXPORT_LIMIT_HOLD_MS:      5 * 60_000,    // min. hold before the export limit may deactivate (anti-oscillation)

  // ── Solcast PV forecast ──────────────────────────────────────────────────
  // Solcast's free Hobbyist tier allows ~10 API calls/day. Fetch at most every 3 h
  // (≤ 8/day) and persist the last fetch time so app restarts don't burn the budget.
  SOLCAST_BASE_URL:          'https://api.solcast.com.au',
  PV_FORECAST_MIN_INTERVAL_MS: 3 * 60 * 60_000,  // ≥ 3 h between successful fetches
  PV_FORECAST_BACKOFF_MS:      6 * 60 * 60_000,  // wait this long after an error / HTTP 429
  PV_FORECAST_TIMEOUT_MS:      15_000,
  PV_FORECAST_STALE_MS:        24 * 60 * 60_000, // older than this → treat as unavailable (fetches stuck)

  // ── Price forecast (D10) ─────────────────────────────────────────────────
  // Pushed via the ems_set_price_forecast flow action (e.g. from "Power by the Hour"
  // / Tibber / any price app) — no active fetch, so no rate limit. Staleness just
  // detects a broken/removed source flow.
  // Most day-ahead sources (Power by the Hour, Tibber, …) push once per day, so the
  // gap between updates is normally close to 24h — a 6h threshold flagged this as
  // stale for most of every day, spending most of the time in the fail-safe
  // (continuous charging) instead of actually price-optimising. 30h tolerates a
  // ~24h cadence plus slack for the trigger firing a bit later some days, while
  // still catching a genuinely broken/removed source flow within a day and a half.
  PRICE_FORECAST_STALE_MS:     30 * 60 * 60_000, // older than this → treat as unavailable
  PRICE_SLOT_HOURS:            1,               // hourly price slots (matches Power by the Hour / most day-ahead feeds)
  // Home-battery price charging has no real-world deadline (unlike an EV that must be
  // ready by a departure time) — it just buys the cheapest available power. A rolling
  // lookahead window (rather than a fixed clock-time cutoff) lets it wait for a
  // genuinely cheaper hour tomorrow instead of being forced to commit by an artificial
  // "by HH:MM" time. 24h keeps the search bounded to what's normally already known.
  PRICE_BATTERY_LOOKAHEAD_MS:  24 * 60 * 60_000,

  // Canonical EMS mode ids — MUST match the ems_mode enum in app.json. Centralised so
  // the value is written once instead of as scattered string literals.
  MODES: Object.freeze({
    IDLE: 'idle', NOT_CONFIGURED: 'not_configured', DISABLED: 'disabled', ERROR: 'error',
    BATTERY_PRIORITY: 'battery_priority', HOLDING: 'holding',
    SOLAR_EV: 'solar_ev', OFFPEAK_EV: 'offpeak_ev', INSTANT_EV: 'instant_ev', PRICE_EV: 'price_ev',
    LOWTARIFF_EV: 'lowtariff_ev',
    SOLAR_HP: 'solar_hp', SOLAR_BOILER: 'solar_boiler', SOLAR_POOL: 'solar_pool',
    SOLAR_DEHUMIDIFIER: 'solar_dehumidifier', SOLAR_AIRCON: 'solar_aircon',
    SOLAR_MULTI: 'solar_multi',
    // history-only mode events (not ems_mode enum values)
    EXPORT_LIMIT_ON: 'export_limit_on', EXPORT_LIMIT_OFF: 'export_limit_off',
  }),
  // History event categories.
  HIST: Object.freeze({ MODE: 'mode', DEVICE: 'device', SYSTEM: 'system', CHARGER: 'charger' }),
};
module.exports.MIN_CHARGE_W = module.exports.AMPS_LADDER[0] * 230; // 1380 W — single-phase minimum
