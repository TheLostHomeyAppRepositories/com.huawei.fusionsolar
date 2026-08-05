'use strict';

const { getDevice } = require('../../lib/widget-data');

// Dashboard language from Homey itself, not navigator.language in the widget — that is
// the browser/OS language and can differ from the Homey app language. See
// widgets/ems-device/api.js for the full rationale.
function lang(homey) {
  try { return homey.i18n.getLanguage() || 'en'; } catch (e) { return 'en'; }
}

module.exports = {
  async getSessions({ homey }) {
    // OCPP charger only — the EMMA Modbus driver has no session history.
    // Driver-registry lookup so opening the widget never boots the OCPP
    // WebSocket server as a side effect.
    const device = getDevice(homey, 'smartcharger_ocpp');
    if (!device || !device.getSessionHistory) {
      return { error: 'No charger registered', lang: lang(homey) };
    }
    const history = await device.getSessionHistory();
    const current = device.getCurrentSessionInfo();
    return { history, current, lang: lang(homey) };
  },
};
