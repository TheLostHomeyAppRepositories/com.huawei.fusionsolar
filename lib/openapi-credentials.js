'use strict';

/**
 * Where the FusionSolar OpenAPI credentials come from when a form needs filling in.
 *
 * One account serves every OpenAPI device: the same username and system code pair a solar
 * plant, a battery, a power sensor and the four iSitePower devices. Typed once per driver
 * that is seven times, and the system code is a machine-generated string nobody remembers
 * — so each pairing dialog asks here first.
 *
 * Two sources, in this order:
 *
 *   1. What the OpenAPI tab in app settings was told to remember. Deliberately first: the
 *      user put it there explicitly, and it is the only source that exists before anything
 *      is paired.
 *   2. An OpenAPI device that is already paired. Its settings hold the credentials it polls
 *      with, so the second device of an account is prefilled even when nothing was saved.
 *
 * Nothing is written from here. Credentials reach app settings only when somebody presses
 * Save on that tab, and reach a device only by pairing it — pairing a device does not
 * quietly widen where the system code is kept.
 *
 * `source` is returned so the dialog can say which of the two it used. A password appearing
 * in a field it was never typed into has to be able to account for itself.
 */

// Every driver that authenticates against the Northbound API. Kept here rather than in each
// caller: the four iSitePower drivers were added later and one caller was not extended with
// them, so "pre-fill from device" quietly found nothing for an account that had four.
const OPENAPI_DRIVER_IDS = [
  'sun2000_openapi_fusionsolar',
  'luna2000_openapi_fusionsolar',
  'powermeter_openapi_fusionsolar',
  'isitepower_solar_openapi_fusionsolar',
  'isitepower_battery_openapi_fusionsolar',
  'isitepower_grid_openapi_fusionsolar',
  'isitepower_home_openapi_fusionsolar',
];

const SETTINGS_KEY = 'openapi_debug_credentials';

const EMPTY = { source: 'none', baseUrl: '', username: '', systemCode: '', stationCode: '' };

/**
 * The credentials the OpenAPI settings tab was told to remember, or null.
 */
function fromSettings(homey) {
  let saved;
  try { saved = homey.settings.get(SETTINGS_KEY); } catch { return null; }
  if (!saved || !saved.username || !saved.systemCode) return null;
  return {
    source:      'settings',
    baseUrl:     saved.baseUrl || '',
    username:    saved.username,
    systemCode:  saved.systemCode,
    stationCode: '',
  };
}

/**
 * The credentials an already paired OpenAPI device polls with, or null.
 *
 * The station code comes along because the settings tab uses it, even though a pairing
 * dialog picks its own station from the list the login returns.
 */
function fromPairedDevice(homey) {
  for (const driverId of OPENAPI_DRIVER_IDS) {
    let driver;
    // A driver can be absent on an install that has never had one, and getDriver throws
    // rather than returning nothing. Not an error here — just the next place to look.
    try { driver = homey.drivers.getDriver(driverId); } catch { continue; }

    let devices = [];
    try { devices = driver.getDevices(); } catch { continue; }

    for (const device of devices) {
      let s;
      try { s = device.getSettings(); } catch { continue; }
      if (s && s.username && s.system_code) {
        return {
          source:      'device',
          baseUrl:     s.base_url || '',
          username:    s.username,
          systemCode:  s.system_code,
          stationCode: s.station_code || '',
        };
      }
    }
  }
  return null;
}

/**
 * Both sources, best first. Always returns an object; `source` is 'none' when neither had
 * anything, and then every field is empty — a caller filling a form must leave its own
 * defaults standing rather than overwrite them with blanks.
 */
function openapiCredentials(homey) {
  return fromSettings(homey) ?? fromPairedDevice(homey) ?? { ...EMPTY };
}

module.exports = {
  openapiCredentials,
  fromSettings,
  fromPairedDevice,
  OPENAPI_DRIVER_IDS,
  SETTINGS_KEY,
};
