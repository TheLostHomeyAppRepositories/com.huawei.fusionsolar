'use strict';

const { Device } = require('homey');
const { DEV_TYPE_SOLAR_GROUP, DEV_TYPE_POWER_CONVERTER, calculate } = require('../../lib/isitepower-utils');

const REQUIRED_CAPABILITIES = [
  'measure_power',
  'meter_power',
];

class ISitePowerSolarDevice extends Device {

  async onInit() {
    this.log(`iSitePower-M Solar device initialised: ${this.getName()}`);
    this._lastEnergyTs = this.getStoreValue('energy_ts') || Date.now();
    this._generatedKwh = this.getStoreValue('generated_kwh') || 0;
    await this._ensureCapabilities();
    this.homey.app.getCoordinator().register(this);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('station_code')) {
      const oldCode = this.getStoreValue('_prev_station_code');
      await this.setStoreValue('_prev_station_code', newSettings.station_code);
      this.homey.app.getCoordinator().reregister(this, oldCode);
    } else if (changedKeys.some((k) => ['base_url', 'username', 'system_code', 'poll_interval'].includes(k))) {
      this.homey.app.getCoordinator().settingsChanged(this);
    }
  }

  async onUninit() { this.homey.app.getCoordinator().unregister(this); }
  async onDeleted() { this.homey.app.getCoordinator().unregister(this); }

  getDevTypes() { return [DEV_TYPE_SOLAR_GROUP, DEV_TYPE_POWER_CONVERTER]; }

  async onPollData({ kpiByType }) {
    const v = calculate(kpiByType);
    await this._set('measure_power', v.solarW);
    if (v.solarCurrentA !== null) {
      if (!this.hasCapability('measure_current')) await this.addCapability('measure_current').catch(() => {});
      await this._set('measure_current', v.solarCurrentA);
    }
    await this._accumulate(v.solarW);

    if (!this.getAvailable()) await this.setAvailable();
    this.log('Poll OK: PV=' + Math.round(v.solarW) + 'W');
  }

  async _accumulate(powerW) {
    const now = Date.now();
    const h = Math.max(0, Math.min(1, (now - this._lastEnergyTs) / 3600000));
    this._lastEnergyTs = now;
    this._generatedKwh += ((powerW || 0) * h) / 1000;
    await this.setStoreValue('energy_ts', now);
    await this.setStoreValue('generated_kwh', this._generatedKwh);
    await this._set('meter_power', Number(this._generatedKwh.toFixed(3)));
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

  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    try { await this.setCapabilityValue(capability, value); } catch (err) {
      this.log(`_set(${capability}, ${value}) failed:`, err.message);
    }
  }

}

module.exports = ISitePowerSolarDevice;
