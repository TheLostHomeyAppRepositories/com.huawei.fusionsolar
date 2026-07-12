'use strict';

const OcppServer = require('../../lib/ocpp-server');

function getDevice(homey) {
  const server = OcppServer.getInstance(homey);
  if (!server || !server.devices) return null;
  for (const dev of server.devices.values()) {
    return dev;
  }
  return null;
}

module.exports = {
  async getSessions({ homey }) {
    const device = getDevice(homey);
    if (!device || !device.getSessionHistory) {
      return { error: 'No charger registered' };
    }
    const history = await device.getSessionHistory();
    const current = device.getCurrentSessionInfo();
    return { history, current };
  },
};
