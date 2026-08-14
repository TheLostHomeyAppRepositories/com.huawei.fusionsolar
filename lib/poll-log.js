'use strict';

/**
 * Throttle for the per-poll "Poll OK" line.
 *
 * A successful poll of a working device is not news. Written on every poll it is,
 * however, 1440 lines a day per device at a 60 s interval — and the app keeps a
 * 1500-line ring buffer (app.js APP_LOG_MAX), so a handful of devices flushes the whole
 * log within hours. A problem noticed the next morning then has nothing around it left
 * to read, which is exactly when the log would be worth having.
 *
 * Failures (`this.error(...)`) and availability changes are logged on their own paths
 * and are untouched by this. Only the "still fine" line is reduced to a heartbeat — it
 * carries the number of polls it stands for, so both liveness and cadence stay visible:
 *
 *     Poll OK: Grid=-1240W  (+15 polls since last line)
 */

const POLL_LOG_HEARTBEAT_MS = 15 * 60_000;

/**
 * Log `message` via `device.log`, but at most once per heartbeat window.
 * State lives on the device instance, so devices throttle independently.
 *
 * @param {object} device   Homey Device (needs .log)
 * @param {string} message  The line to write when the heartbeat is due
 * @param {number} [nowMs]
 * @returns {boolean}       true if the line was written
 */
function logPollOk(device, message, nowMs = Date.now()) {
  const last = device._pollLogAt;
  // `!== undefined`, not a truthiness test: a timestamp of 0 is a legitimate "already
  // logged" marker, and treating it as "never logged" let a second line straight
  // through. `nowMs >= last` guards a backwards clock step (NTP correction, DST on a
  // naive clock): without it a timestamp from the future would suppress every line
  // until real time caught up — for a 15-minute window, possibly the rest of the day.
  if (last !== undefined && nowMs >= last && (nowMs - last) < POLL_LOG_HEARTBEAT_MS) {
    device._pollLogSkipped = (device._pollLogSkipped || 0) + 1;
    return false;
  }
  const skipped = device._pollLogSkipped || 0;
  device._pollLogAt = nowMs;
  device._pollLogSkipped = 0;
  device.log(skipped ? `${message}  (+${skipped} polls since last line)` : message);
  return true;
}

module.exports = { logPollOk, POLL_LOG_HEARTBEAT_MS };
