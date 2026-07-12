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
  async getStatus({ homey }) {
    const device = getDevice(homey);
    if (!device || !device.getWidgetStatus) {
      return { error: 'No charger registered' };
    }
    return device.getWidgetStatus();
  },
};
