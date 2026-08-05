'use strict';

const { getDevice } = require('../../lib/widget-data');

// Charger lookup: OCPP first (full session data), then EMMA Modbus
// (telemetry-only — getWidgetStatus degrades gracefully). Uses the driver
// registry rather than OcppServer.getInstance() so merely opening the
// widget never boots the OCPP WebSocket server.
function getChargerDevice(homey) {
  return getDevice(homey, 'smartcharger_ocpp')
    || getDevice(homey, 'smartcharger_emma_modbus');
}

// Dashboard language from Homey itself, not navigator.language in the widget — that is
// the browser/OS language and can differ from the Homey app language. See
// widgets/ems-device/api.js for the full rationale.
function lang(homey) {
  try { return homey.i18n.getLanguage() || 'en'; } catch (e) { return 'en'; }
}

module.exports = {
  async getStatus({ homey }) {
    const device = getChargerDevice(homey);
    if (!device || typeof device.getWidgetStatus !== 'function') {
      return { error: 'No charger registered', lang: lang(homey) };
    }
    return { ...device.getWidgetStatus(), lang: lang(homey) };
  },
};
