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

    if (!hasInv || battery.soc === null || gridW === null) return;

    // Guard against misconfiguration: the deactivate SOC must be below the trigger SOC,
    // otherwise the limit would deactivate on the same tick it activates.
    if (deactSoc >= trigSoc) {
      if (!this._loggedExportSocMisconfig) {
        this.log(`[EMS] export limit: deactivate SOC (${deactSoc}%) ≥ trigger SOC (${trigSoc}%) — clamping to ${trigSoc - 1}%`);
        this._loggedExportSocMisconfig = true;
      }
      deactSoc = trigSoc - 1;
    }

    const batFull   = battery.soc >= trigSoc;
    const exporting = gridW < -EXPORT_LIMIT_MIN_EXPORT_W;

    const shouldActivate   = !this._exportLimitActive && batFull && exporting;
    // Require a minimum hold time before deactivating: when the limit activates and cuts export,
    // the inverter stops exporting, which would immediately flip shouldDeactivate → oscillation.
    const heldLongEnough = !this._exportLimitActivatedAt
                           || (Date.now() - this._exportLimitActivatedAt) >= EXPORT_LIMIT_HOLD_MS;
    const shouldDeactivate = this._exportLimitActive && heldLongEnough
                             && (battery.soc < deactSoc || !exporting);

    if (shouldActivate) {
      this._exportLimitActive      = true;
      this._exportLimitActivatedAt = Date.now();
      await this._persistExportLimit();
      this.log(`[EMS] export limit ON — SOC ${Math.round(battery.soc)}% ≥ ${trigSoc}%, export ${Math.round(-gridW)}W`);
      this._addHistoryEvent(HIST.MODE, MODES.EXPORT_LIMIT_ON, `SOC ${Math.round(battery.soc)}% · export ${Math.round(-gridW)}W`);
      await this._fireExportLimitTrigger(cfg, 'ems_inverter_export_limit_on', 'ON');
    } else if (shouldDeactivate) {
      this._exportLimitActive      = false;
      this._exportLimitActivatedAt = null;
      await this._persistExportLimit();
      this.log(`[EMS] export limit OFF — SOC ${Math.round(battery.soc)}% < ${deactSoc}% or no export`);
      this._addHistoryEvent(HIST.MODE, MODES.EXPORT_LIMIT_OFF, `SOC ${Math.round(battery.soc)}%`);
      await this._fireExportLimitTrigger(cfg, 'ems_inverter_export_limit_off', 'OFF');
    }
  },

};
