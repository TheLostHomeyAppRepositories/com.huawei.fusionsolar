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

// A device that is unreachable repeats the same failure every poll — a week offline is
// ~10'000 identical EHOSTUNREACH lines, which empties the ring buffer just as thoroughly
// as the success lines did, and takes the onset of the fault with it.
//
// Errors are not throttled the way successes are, because losing one can hide a real
// problem. Three things always get through:
//   - the first ERROR_ALWAYS_FIRST failures of a run. The Modbus drivers call
//     setUnavailable at the third, so the whole descent into "unavailable" stays intact.
//   - any change in the message: a different fault is a different story, and the counter
//     restarts so that story gets its own three lines.
//   - recovery, via logPollOk below.
// Only the unchanged repetition beyond that is reduced to a heartbeat.
const ERROR_ALWAYS_FIRST = 3;

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
  // Coming back from a failure run is always worth a line, whatever the heartbeat says:
  // it is the moment that closes off the errors above it, and without it a device could
  // fall over and recover inside one window leaving only the failures on record.
  const recovering = (device._pollErrCount || 0) > 0;
  device._pollErrKey = undefined;
  device._pollErrCount = 0;
  device._pollErrAt = undefined;
  device._pollErrSkipped = 0;

  const last = recovering ? undefined : device._pollLogAt;
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

/**
 * Log a failing poll via `device.error`, throttling only unchanged repetition.
 *
 * @param {object} device  Homey Device (needs .error)
 * @param {string} line    The line to write
 * @param {string} [key]   What makes this failure "the same" as the previous one.
 *                         Pass the bare error text: the rendered line usually carries a
 *                         failure counter, which changes every poll and would defeat the
 *                         comparison entirely.
 * @param {number} [nowMs]
 * @returns {boolean}      true if the line was written
 */
function logPollError(device, line, key = line, nowMs = Date.now()) {
  if (device._pollErrKey !== key) {
    device._pollErrKey = key;
    device._pollErrCount = 0;
    device._pollErrAt = undefined;
    device._pollErrSkipped = 0;
  }
  device._pollErrCount = (device._pollErrCount || 0) + 1;

  const last = device._pollErrAt;
  const due  = last === undefined || nowMs < last || (nowMs - last) >= POLL_LOG_HEARTBEAT_MS;
  if (device._pollErrCount > ERROR_ALWAYS_FIRST && !due) {
    device._pollErrSkipped = (device._pollErrSkipped || 0) + 1;
    return false;
  }

  const skipped = device._pollErrSkipped || 0;
  device._pollErrAt = nowMs;
  device._pollErrSkipped = 0;
  device.error(skipped ? `${line}  (+${skipped} identical failures since last line)` : line);
  return true;
}

module.exports = { logPollOk, logPollError, POLL_LOG_HEARTBEAT_MS, ERROR_ALWAYS_FIRST };
