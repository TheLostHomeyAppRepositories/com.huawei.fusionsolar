'use strict';

const { Device } = require('homey');
const OcppServer = require('../../lib/ocpp-server');

const REQUIRED_CAPABILITIES = [
  'onoff',
  'target_current',
  'measure_power',
  'meter_power',
  'evcharger_charging_state',
  'vehicle_soc',
  'ocpp_server_status',
  'ocpp_last_message',
];

class SmartChargerOcppDevice extends Device {

  async onInit() {
    this.log(`[OCPP] Device initialised: ${this.getName()}`);
    await this._ensureCapabilities();

    this._txnId = null; // authoritative txnId lives in OcppServer._txnIds

    // Register this device with the shared OCPP server
    const stationId = this.getSetting('station_id');
    const server    = OcppServer.getInstance(this.homey);
    server.registerDevice(stationId, this);
    server.setCredentials(stationId, this.getSetting('ocpp_username'), this.getSetting('ocpp_password'));

    await this._set('ocpp_server_status', 'starting');
    await this._set('evcharger_charging_state', 'idle');
    await this._set('onoff', false);
    await this._set('target_current', 16);

    this._registerCapabilityListeners();
    this._registerFlowActions();
  }

  async onSettings({ newSettings }) {
    const stationId = this.getSetting('station_id');
    OcppServer.getInstance(this.homey)
      .setCredentials(stationId, newSettings.ocpp_username, newSettings.ocpp_password);
  }

  async onDeleted() {
    const stationId = this.getSetting('station_id');
    OcppServer.getInstance(this.homey).unregisterDevice(stationId);
  }

  async onUninit() {
    const stationId = this.getSetting('station_id');
    OcppServer.getInstance(this.homey).unregisterDevice(stationId);
  }

  // ─── Called by OcppServer when a message arrives ──────────────────────────

  onOcppConnected() {
    this.log('[OCPP] Charger connected');
    this._set('ocpp_server_status', 'connected').catch(() => {});
  }

  onOcppDisconnected() {
    this.log('[OCPP] Charger disconnected');
    this._set('ocpp_server_status', 'waiting').catch(() => {});
    this._set('evcharger_charging_state', 'idle').catch(() => {});
    this._set('measure_power', 0).catch(() => {});
  }

  onBootNotification(payload) {
    this.log('[OCPP] BootNotification:', JSON.stringify(payload));
    this._set('ocpp_last_message', 'Boot: ' + (payload.chargePointModel || '?')).catch(() => {});
    if (!this.getAvailable()) this.setAvailable().catch(() => {});
  }

  onStatusNotification(payload) {
    this.log('[OCPP] StatusNotification:', JSON.stringify(payload));
    const status = (payload.status || '').toLowerCase();
    let homeyState = 'idle';
    if (status === 'charging')                                homeyState = 'charging';
    else if (status === 'preparing' || status === 'suspendedev') homeyState = 'idle';
    else if (status === 'faulted')                            homeyState = 'error';
    this._set('evcharger_charging_state', homeyState).catch(() => {});
    this._set('ocpp_last_message', 'Status: ' + (payload.status || '?')).catch(() => {});
  }

  onMeterValues(payload) {
    this.log('[OCPP] MeterValues:', JSON.stringify(payload));
    for (const mv of (payload.meterValue || [])) {
      for (const sv of (mv.sampledValue || [])) {
        const measurand = sv.measurand || 'Energy.Active.Import.Register';
        let val = parseFloat(sv.value);
        if (!Number.isFinite(val)) continue;
        // Scale units: charger may send kW, kWh, kA instead of W, Wh, A
        const unit = (sv.unit || '').toLowerCase();
        if (unit.startsWith('k')) val *= 1000;
        else if (unit.startsWith('m')) val /= 1000;

        if (measurand === 'Power.Active.Import') {
          this._set('measure_power', Math.round(val)).catch(() => {});
        } else if (measurand === 'Energy.Active.Import.Register') {
          // val is now in Wh → convert to kWh for meter_power
          this._set('meter_power', parseFloat((val / 1000).toFixed(3))).catch(() => {});
        } else if (measurand === 'SoC') {
          this._set('vehicle_soc', Math.round(val)).catch(() => {});
        }
      }
    }
    this._set('ocpp_last_message', 'MeterValues received').catch(() => {});
  }

  onStartTransaction(payload, txnId) {
    this.log('[OCPP] StartTransaction txnId:', txnId);
    this._txnId = txnId;
    this._set('onoff', true).catch(() => {});
    this._set('evcharger_charging_state', 'charging').catch(() => {});
    this._set('ocpp_last_message', 'Charging started').catch(() => {});
    this.homey.flow.getDeviceTriggerCard('ocpp_charging_started')
      .trigger(this, {}).catch((err) => this.log('Trigger failed:', err.message));
  }

  onStopTransaction(payload) {
    this.log('[OCPP] StopTransaction:', JSON.stringify(payload));
    this._txnId = null; // authoritative txnId lives in OcppServer._txnIds
    this._set('onoff', false).catch(() => {});
    const energyKwh = payload.meterStop ? parseFloat((payload.meterStop / 1000).toFixed(3)) : null;
    if (energyKwh !== null) this._set('meter_power', energyKwh).catch(() => {});
    this._set('evcharger_charging_state', 'idle').catch(() => {});
    this._set('measure_power', 0).catch(() => {});
    this._set('ocpp_last_message', 'Charging stopped').catch(() => {});
    this.homey.flow.getDeviceTriggerCard('ocpp_charging_stopped')
      .trigger(this, {}).catch((err) => this.log('Trigger failed:', err.message));
  }

  onServerStarted(port) {
    this.log(`[OCPP] Server listening on port ${port}`);
    this._set('ocpp_server_status', 'waiting').catch(() => {});
  }

  onServerError(err) {
    this.error('[OCPP] Server error:', err.message);
    this._set('ocpp_server_status', 'error').catch(() => {});
    this.setUnavailable('OCPP server error: ' + err.message).catch(() => {});
  }

  // ─── Capability listeners (direct device controls) ───────────────────────

  _registerCapabilityListeners() {
    const stationId = this.getSetting('station_id');
    const server    = () => OcppServer.getInstance(this.homey);

    this.registerCapabilityListener('onoff', async (value) => {
      if (value) {
        server().remoteStart(stationId);
      } else {
        server().remoteStop(stationId);
      }
    });

    this.registerCapabilityListener('target_current', async (value) => {
      server().setMaxCurrent(stationId, value);
    });
  }

  // ─── Flow actions ─────────────────────────────────────────────────────────

  _registerFlowActions() {
    const stationId = this.getSetting('station_id');
    const server = () => OcppServer.getInstance(this.homey);

    this.homey.flow.getActionCard('ocpp_set_max_current')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        server().setMaxCurrent(stationId, args.amperes);
      });

    this.homey.flow.getActionCard('ocpp_remote_start')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        server().remoteStart(stationId);
      });

    this.homey.flow.getActionCard('ocpp_remote_stop')
      .registerRunListener(async (args) => {
        if (args.device.id !== this.id) return;
        server().remoteStop(stationId);
      });
  }

  // ─── Capabilities ─────────────────────────────────────────────────────────

  async _ensureCapabilities() {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        try { await this.addCapability(cap); } catch (err) {
          this.error(`addCapability(${cap}) failed:`, err.message);
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

module.exports = SmartChargerOcppDevice;
