'use strict';

const { Driver }    = require('homey');
const HomeyLocalApi = require('../../lib/homey-local-api');

class EmsDriver extends Driver {

  async onInit() {
    this.log('[EMS Driver] initialized');
    this._registerFlowCards();
  }

  _registerFlowCards() {
    this.homey.flow.getConditionCard('ems_is_in_mode')
      .registerRunListener(async (args) => {
        return args.device.getCapabilityValue('ems_mode') === args.mode;
      });

    this.homey.flow.getActionCard('ems_set_enabled')
      .registerRunListener(async (args) => {
        const enabled = args.enabled === 'true' || args.enabled === true;
        await args.device.setCapabilityValue('onoff', enabled);
        args.device._onEnabledChanged(enabled);
      });
  }

  async onPair(session) {
    session.setHandler('validate_and_create', async ({ apiKey } = {}) => {
      // Enforce single EMS device
      if (this.getDevices().length > 0) {
        return { error: 'An EMS device already exists. Only one EMS device is allowed per Homey.' };
      }
      if (!apiKey) {
        return { error: 'No API key provided.' };
      }
      // Validate the key by doing a quick device list fetch
      try {
        const api = new HomeyLocalApi({ homey: this.homey, apiKey });
        await api.getDevices();
      } catch (err) {
        return { error: `API key validation failed: ${err.message}` };
      }
      return { ok: true };
    });
  }

}

module.exports = EmsDriver;
