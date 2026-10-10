'use strict';

const { Device } = require('homey');
const { withSettingsLog } = require('../../lib/change-log');
const { DEV_TYPE_MAINS, DEV_TYPE_AC_OUTPUT, DEV_TYPE_SOLAR_GROUP, DEV_TYPE_BATTERY_RACK, calculate, integrationHours } = require('../../lib/isitepower-utils');
const { logPollOk } = require('../../lib/poll-log');
const capabilitySet = require('../../lib/capability-set');

const REQUIRED_CAPABILITIES = [
  'measure_power',
  'meter_power',
  'meter_power.exported',
  'measure_voltage.phase1',
  'measure_current.phase1',
  'measure_frequency',
];

class ISitePowerGridDevice extends Device {

  async onInit() {
    this.log(`iSitePower-M Grid device initialised: ${this.getName()}`);
    this._prevExporting  = null;
    this._prevGridW      = 0;
    this._lastEnergyTs   = this.getStoreValue('energy_ts') || Date.now();
    this._importedKwh    = this.getStoreValue('imported_kwh') || 0;
    const offset         = Number(this.getStoreValue('mains_offset'));
    this._mainsOffset    = this.getStoreValue('mains_offset') == null || !Number.isFinite(offset) ? null : offset;
    await this._ensureCapabilities();
    await this._set('meter_power.exported', 0);
    this.homey.app.getCoordinator().register(this);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('station_code')) {
      const oldCode = this.getStoreValue('_prev_station_code');
      await this.setStoreValue('_prev_station_code', newSettings.station_code);
      this.homey.app.getCoordinator().reregister(this, oldCode, newSettings.station_code);
    } else if (changedKeys.some((k) => ['base_url_region', 'base_url', 'username', 'system_code', 'poll_interval'].includes(k))) {
      // newSettings, not getSetting(): Homey persists only after this resolves, so the
      // coordinator would otherwise copy the OLD values onto the sibling devices.
      this.homey.app.getCoordinator().settingsChanged(this, newSettings);
    }
  }

  async onUninit() { this.homey.app.getCoordinator().unregister(this); }
  async onDeleted() { this.homey.app.getCoordinator().unregister(this); }

  getDevTypes() { return [DEV_TYPE_MAINS, DEV_TYPE_AC_OUTPUT, DEV_TYPE_SOLAR_GROUP, DEV_TYPE_BATTERY_RACK]; }

  async onPollData({ kpiByType, freshKpiByType }) {
    const v = calculate(kpiByType, freshKpiByType);

    // Grid is calculated, not measured — suppress single-poll spikes caused by
    // timing differences between AC output and battery sensors.
    // Only report grid > 0 if it was also > 0 on the previous poll.
    const GRID_THRESHOLD = 50;
    const rawGridW = v.gridImportW;
    let gridW;
    if (rawGridW <= GRID_THRESHOLD) {
      gridW = 0;
    } else if (this._prevGridW > GRID_THRESHOLD) {
      gridW = rawGridW;
    } else {
      gridW = 0;
    }
    this._prevGridW = rawGridW;

    await this._set('measure_power', gridW);
    await this._set('measure_voltage.phase1', v.acVoltage);
    await this._set('measure_current.phase1', v.acCurrent);
    await this._set('measure_frequency', v.acFrequency);

    // Cumulative grid import: prefer direct 60001 total_energy_consumption (authoritative meter
    // reading) over local time-integration. Guard with Math.max to prevent backward jumps when
    // only one of two Mains units returns data in a given poll cycle.
    //
    // Followed by its increments from where this meter stands, not copied. A first poll
    // without Mains data — the grace cycle after pairing, a 407, the type missing from the first
    // device list — started the integral below at 0, and the next poll with Mains data wrote its
    // lifetime total: 0 → 4212.5 kWh, booked by Homey Energy as one interval of import (review
    // 2026-10-10). The offset is fixed the first time Mains data is seen and kept in the store.
    // It is 0 when this meter has shown nothing yet (it then reads the Mains meter's own total),
    // and 0 when it already stands at or near that total — an installation that followed the
    // Mains meter before this, where what was used while the app was down is real import. Only
    // a meter well below it, counted up from 0 here, continues from where it stands.
    if (v.mainsTotalKwh !== null && v.mainsTotalKwh > 0) {
      if (this._mainsOffset === null) {
        const shown = this.getCapabilityValue('meter_power');
        const following = shown === null || shown === undefined || this._importedKwh >= 0.95 * v.mainsTotalKwh;
        this._mainsOffset = following ? 0 : this._importedKwh - v.mainsTotalKwh;
        await this.setStoreValue('mains_offset', this._mainsOffset);
        this.log(`Mains meter found: ${v.mainsTotalKwh} kWh — import follows its increments from ${this._importedKwh.toFixed(3)} kWh (offset ${this._mainsOffset.toFixed(3)})`);
      }
      const newKwh = Math.max(this._importedKwh, v.mainsTotalKwh + this._mainsOffset);
      if (newKwh !== this._importedKwh) {
        this._importedKwh = newKwh;
        await this.setStoreValue('imported_kwh', newKwh);
        await this._set('meter_power', Number(newKwh.toFixed(3)));
      }
      this._lastEnergyTs = Date.now();
    } else {
      await this._accumulate(gridW);
    }

    // Availability is the coordinator's call, made right after this returns — from what the
    // plant delivered, the same as for every other cloud device. Setting it here as well made a
    // device with no data flip to available and back on every poll (review 2026-10-10).
    logPollOk(this, 'Poll OK: Grid=' + Math.round(gridW) + 'W (raw=' + Math.round(rawGridW) + 'W)');
  }

  async _accumulate(importW) {
    const now = Date.now();
    const h = integrationHours(this._lastEnergyTs, now, parseInt(this.getSetting('poll_interval'), 10));
    this._lastEnergyTs = now;
    this._importedKwh += ((importW || 0) * h) / 1000;
    await this.setStoreValue('energy_ts', now);
    await this.setStoreValue('imported_kwh', this._importedKwh);
    await this._set('meter_power', Number(this._importedKwh.toFixed(3)));
  }

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        try { await this.addCapability(cap); } catch (err) {
          this.error("addCapability(" + cap + ") failed:", err.message);
        }
      }
    }
  }

}

Object.assign(ISitePowerGridDevice.prototype, capabilitySet);

// Every saved settings page in the log and the change log — see lib/change-log.js.
withSettingsLog(ISitePowerGridDevice);

module.exports = ISitePowerGridDevice;
