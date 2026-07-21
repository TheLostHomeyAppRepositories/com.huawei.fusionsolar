'use strict';

const { getDevice } = require('../../lib/widget-data');

module.exports = {
  async getSessions({ homey }) {
    // OCPP charger only — the EMMA Modbus driver has no session history.
    // Driver-registry lookup so opening the widget never boots the OCPP
    // WebSocket server as a side effect.
    const device = getDevice(homey, 'smartcharger_ocpp');
    if (!device || !device.getSessionHistory) {
      return { error: 'No charger registered' };
    }
    const history = await device.getSessionHistory();
    const current = device.getCurrentSessionInfo();
    return { history, current };
  },
};
