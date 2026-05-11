'use strict';

// All Modbus driver IDs — used to pause their polling during pairing probes.
const MODBUS_DRIVER_IDS = [
  'sun2000_modbus',
  'luna2000_modbus',
  'dtsu666_modbus',
  'sdongle_a_modbus',
  'sun2000_emma_modbus',
  'luna2000_emma_modbus',
  'powermeter_emma_modbus',
  'smartcharger_emma_modbus',
];

/**
 * Pause polling for every Modbus device whose IP matches `host`,
 * then wait (up to 2 s) for any in-flight fetch to finish.
 *
 * Returns the list of paused devices — pass it to resumePairedDevices()
 * inside a finally block to guarantee polling is always restored.
 *
 * @param {import('homey').Homey} homey
 * @param {string} host  IP address of the target device
 * @returns {Promise<object[]>}
 */
async function pauseDevicesOnHost(homey, host) {
  const paused = [];

  for (const driverId of MODBUS_DRIVER_IDS) {
    let driver;
    try { driver = homey.drivers.getDriver(driverId); } catch { continue; }

    for (const device of driver.getDevices()) {
      try {
        if ((device.getSetting('address') || '').trim() !== host) continue;
        if (typeof device._stopPolling === 'function') {
          await device._stopPolling();
          paused.push(device);
        }
      } catch { /* ignore individual device errors */ }
    }
  }

  // Wait for any fetch that was already in-flight (max 2 s)
  const deadline = Date.now() + 2000;
  for (const d of paused) {
    while (d._fetchInProgress && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100)); // eslint-disable-line no-promise-executor-return
    }
  }

  return paused;
}

/**
 * Resume polling for every device returned by pauseDevicesOnHost().
 * Safe to call even if the list is empty.
 *
 * @param {object[]} paused
 */
async function resumePairedDevices(paused) {
  for (const d of paused) {
    try {
      if (typeof d._startPolling === 'function') await d._startPolling();
    } catch { /* ignore */ }
  }
}

/**
 * Safe parseInt that handles 0 correctly.
 * `parseInt("0") || fallback` would return `fallback` because 0 is falsy.
 * This function returns `fallback` only when the parsed value is NaN.
 *
 * @param {string|number} value
 * @param {number} fallback
 * @returns {number}
 */
function parseIntSafe(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { pauseDevicesOnHost, resumePairedDevices, parseIntSafe };
