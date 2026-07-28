'use strict';

// Shared EMS constants. Extracted from drivers/energy_management/device.js so the
// device orchestrator and the lib/ems/* mixins reference one source of truth.
module.exports = {
  TICK_MS:                  15_000,
  STEP_HOLD_MS:             30_000,
  IMPORT_HOLD_MS:           60_000,
  FLIP_COOLDOWN_MS:         5 * 60_000,
  SIMPLE_MIN_RUN_MS:        5 * 60_000,  // min run time for HP/boiler/pool before stop allowed
  EMS_HISTORY_MAX:          400,          // max history events kept in memory + settings
  PHASE_SWITCH_COOLDOWN_MS: 10 * 60_000,
  GRID_SENSOR_HOLD_TICKS:   4,            // use last-valid gridW for up to 4 ticks (60 s) on sensor failure
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

  // Canonical EMS mode ids — MUST match the ems_mode enum in app.json. Centralised so
  // the value is written once instead of as scattered string literals.
  MODES: Object.freeze({
    IDLE: 'idle', NOT_CONFIGURED: 'not_configured', DISABLED: 'disabled', ERROR: 'error',
    BATTERY_PRIORITY: 'battery_priority', HOLDING: 'holding',
    SOLAR_EV: 'solar_ev', OFFPEAK_EV: 'offpeak_ev', INSTANT_EV: 'instant_ev',
    SOLAR_HP: 'solar_hp', SOLAR_BOILER: 'solar_boiler', SOLAR_POOL: 'solar_pool',
    SOLAR_DEHUMIDIFIER: 'solar_dehumidifier', SOLAR_MULTI: 'solar_multi',
    // history-only mode events (not ems_mode enum values)
    EXPORT_LIMIT_ON: 'export_limit_on', EXPORT_LIMIT_OFF: 'export_limit_off',
  }),
  // History event categories.
  HIST: Object.freeze({ MODE: 'mode', DEVICE: 'device', SYSTEM: 'system', CHARGER: 'charger' }),
};
module.exports.MIN_CHARGE_W = module.exports.AMPS_LADDER[0] * 230; // 1380 W — single-phase minimum
