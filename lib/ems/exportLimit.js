'use strict';

// Export-limit coordinator: fires ems_inverter_export_limit_on / _off trigger
// cards based on battery SOC + grid export. Users link those triggers to inverter
// action cards. Mixed into EmsDevice.prototype; `this` is the device instance.
const { EXPORT_LIMIT_MIN_EXPORT_W, EXPORT_LIMIT_HOLD_MS, MODES, HIST } = require('./constants');

module.exports = {

  async _persistExportLimit() {
    await this.setStoreValue('exportLimitState', {
      active:      this._exportLimitActive,
      activatedAt: this._exportLimitActivatedAt,
    }).catch(() => {});
  },

  // Fires the on/off trigger for EVERY configured inverter (multi-inverter
  // installations throttle all of them, not just the first).
  async _fireExportLimitTrigger(cfg, cardId, logLabel) {
    const invIds = (cfg.inverter_devices || []).map((d) => d.id).filter(Boolean);
    for (const invId of invIds) {
      this.log(`[EMS] export limit ${logLabel} → trigger ${cardId} (inverter ${invId})`);
      await this.homey.flow.getTriggerCard(cardId)
        .trigger({ inverter_device_id: invId }, { inverter_device_id: invId })
        .catch((e) => this.log(`[EMS] export limit ${logLabel} trigger failed (${invId}): ${e.message}`));
    }
  },

  async _evaluateExportLimit(cfg, battery, gridW) {
    if (!cfg.export_limit_enabled) {
      // If the coordinator was just disabled while active, fire a deactivate to be safe
      if (this._exportLimitActive) {
        this._exportLimitActive      = false;
        this._exportLimitActivatedAt = null;
        await this._persistExportLimit();
        await this._fireExportLimitTrigger(cfg, 'ems_inverter_export_limit_off', 'OFF (disabled)');
      }
      return;
    }

    const trigSoc  = Number(cfg.export_limit_trigger_soc    ?? 95);
    let   deactSoc = Number(cfg.export_limit_deactivate_soc ?? 90);
    const hasInv   = (cfg.inverter_devices || []).some((d) => d.id);

    if (!hasInv) return;

    // Zero export: the limit is held permanently, independent of SOC, export and price.
    // It must therefore be evaluated BEFORE the sensor guard below — a missing meter
    // reading is no reason to let the inverter feed in again.
    if (cfg.export_limit_zero_export === true) {
      if (!this._exportLimitActive) {
        this._exportLimitActive      = true;
        this._exportLimitActivatedAt = Date.now();
        await this._persistExportLimit();
        this.log('[EMS] export limit ON — zero export (permanent)');
        this._addHistoryEvent(HIST.MODE, MODES.EXPORT_LIMIT_ON, 'Zero export');
        await this._fireExportLimitTrigger(cfg, 'ems_inverter_export_limit_on', 'ON (zero export)');
      }
      return;
    }

    // Every remaining rule needs to know whether we are actually exporting.
    if (gridW === null) return;

    // The battery-full rule is opt-OUT, so installations that predate the price and zero
    // rules keep working without a migration. It contributes nothing when the user turned
    // it off or when there is no battery at all — the price rule must still work there,
    // which is why a missing SOC no longer aborts the whole evaluation.
    const socRule = cfg.export_limit_on_battery_full !== false
                    && typeof battery.soc === 'number';

    if (socRule) {
      // Guard against misconfiguration: the deactivate SOC must be below the trigger SOC,
      // otherwise the limit would deactivate on the same tick it activates.
      if (deactSoc >= trigSoc) {
        if (!this._loggedExportSocMisconfig) {
          this.log(`[EMS] export limit: deactivate SOC (${deactSoc}%) ≥ trigger SOC (${trigSoc}%) — clamping to ${trigSoc - 1}%`);
          this._loggedExportSocMisconfig = true;
        }
        deactSoc = trigSoc - 1;
      } else {
        // Re-arm once the configuration is valid again, so a later misconfiguration is
        // reported instead of staying silent for the rest of the app's lifetime — same
        // convention as the other one-shot log guards (_loggedNoMeterDevices,
        // _pvForecastLoggedErr, _priceForecastStaleNotified).
        this._loggedExportSocMisconfig = false;
      }
    }

    const exporting = gridW < -EXPORT_LIMIT_MIN_EXPORT_W;

    // Price-based limiting: while feeding in costs money, throttle regardless of SOC.
    // The threshold defaults to 0 ("only when the price is actually negative") but is
    // configurable, because some tariffs make export unattractive slightly above zero.
    let priceLow = false;
    let priceNow = null;
    if (cfg.export_limit_on_negative_price === true) {
      priceNow = this._getCurrentPrice(cfg);
      priceLow = priceNow !== null
                 && priceNow < Number(cfg.export_limit_price_threshold ?? 0);
    }

    // Activation uses the trigger SOC, deactivation the (lower) deactivate SOC — the
    // hysteresis that keeps the limit from flapping around a single threshold. The price
    // reason has no such band; the tariff itself changes only hourly at most.
    const socOn   = socRule && battery.soc >= trigSoc;
    const socHold = socRule && battery.soc >= deactSoc;

    const wantOn   = exporting && (socOn   || priceLow);
    const wantHold = exporting && (socHold || priceLow);

    // Require a minimum hold time before deactivating: when the limit activates and cuts export,
    // the inverter stops exporting, which would immediately flip shouldDeactivate → oscillation.
    const heldLongEnough = !this._exportLimitActivatedAt
                           || (Date.now() - this._exportLimitActivatedAt) >= EXPORT_LIMIT_HOLD_MS;

    if (!this._exportLimitActive && wantOn) {
      // SOC wins the label when both reasons apply: its thresholds are what explain the
      // following OFF.
      const reason = socOn
        ? `SOC ${Math.round(battery.soc)}% ≥ ${trigSoc}%`
        : `price ${priceNow} < ${Number(cfg.export_limit_price_threshold ?? 0)}`;
      this._exportLimitActive      = true;
      this._exportLimitActivatedAt = Date.now();
      await this._persistExportLimit();
      this.log(`[EMS] export limit ON — ${reason}, export ${Math.round(-gridW)}W`);
      this._addHistoryEvent(HIST.MODE, MODES.EXPORT_LIMIT_ON, `${reason} · export ${Math.round(-gridW)}W`);
      await this._fireExportLimitTrigger(cfg, 'ems_inverter_export_limit_on', 'ON');
    } else if (this._exportLimitActive && heldLongEnough && !wantHold) {
      // Name the condition that actually ended it, so an installation without a battery
      // does not get an OFF reason phrased in terms of a SOC it never had.
      const reason = !exporting ? 'no export'
        : socRule ? `SOC ${Math.round(battery.soc)}% < ${deactSoc}%, price high`
        : 'price high';
      this._exportLimitActive      = false;
      this._exportLimitActivatedAt = null;
      await this._persistExportLimit();
      this.log(`[EMS] export limit OFF — ${reason}`);
      this._addHistoryEvent(HIST.MODE, MODES.EXPORT_LIMIT_OFF, reason);
      await this._fireExportLimitTrigger(cfg, 'ems_inverter_export_limit_off', 'OFF');
    }
  },

};
