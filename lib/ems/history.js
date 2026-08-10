'use strict';

// EMS history + timeline notifications. Mixed into EmsDevice.prototype; `this` is
// the device instance. See drivers/energy_management/device.js.
const { EMS_HISTORY_MAX } = require('./constants');

module.exports = {

  /**
   * Books a tick the loop could not run because the previous one was still going.
   *
   * Lives here rather than inline in _tick() so it can be tested at all — device.js needs
   * the `homey` module and never loads in the test process. It also belongs with the other
   * "tell the user something happened" code: the counting is trivial, the judgement of
   * when to speak up is not.
   *
   * One skip is a single slow tick and harmless. Two in a row means the running tick has
   * outlasted two whole intervals, so the loop has stopped keeping time — that is worth a
   * word. Throttled to once an hour, because while the cause persists this fires every
   * other tick and a notification every 30 s would bury the timeline it means to warn in.
   *
   * @returns {boolean} true when this skip crossed the threshold and was announced
   */
  _noteTickSkip(tickMs, now = Date.now()) {
    this._diag.tickSkipped += 1;
    this._consecSkips = (this._consecSkips || 0) + 1;
    if (this._consecSkips !== 2) return false;

    this.log(`[EMS] tick overrun — 2 skipped in a row `
      + `(avg ${this._diag.avgTickMs} ms, max ${this._diag.maxTickMs} ms, interval ${tickMs} ms)`);
    if (this._lastOverrunNotify && (now - this._lastOverrunNotify) <= 60 * 60_000) return false;
    this._lastOverrunNotify = now;
    this._postNotification(`EMS: Tick überlastet — ein Durchlauf dauert bis zu ${this._diag.maxTickMs} ms, Takt ist ${tickMs} ms`);
    return true;
  },

  _postNotification(excerpt) {
    if (!this.getSetting('enable_timeline_notifications')) return;
    this.homey.notifications.createNotification({ excerpt })
      .catch((e) => this.log(`[EMS] notification: ${e.message}`));
  },

  _addHistoryEvent(type, event, label, deviceId = null) {
    this._emsHistory.push({ ts: Date.now(), type, event, label, deviceId });
    if (this._emsHistory.length > EMS_HISTORY_MAX) this._emsHistory.splice(0, this._emsHistory.length - EMS_HISTORY_MAX);
    // Persist mode/device/system events, but coalesce bursts: one tick can add several
    // (mode + device start/stop), and writing the whole array to settings on each one is
    // wasteful. Debounce to a single write ~2 s after the last event. (Charger events are
    // saved periodically from the tick loop.)
    if (type === 'mode' || type === 'device' || type === 'system') this._scheduleHistorySave();
  },

  _scheduleHistorySave() {
    if (this._historySaveTimer) return; // a save is already pending
    this._historySaveTimer = this.homey.setTimeout(() => {
      this._historySaveTimer = null;
      this._saveHistory();
    }, 2000);
  },

  // Cancel any pending debounced save and persist immediately (call on shutdown).
  _flushHistorySave() {
    if (this._historySaveTimer) { this.homey.clearTimeout(this._historySaveTimer); this._historySaveTimer = null; }
    this._saveHistory();
  },

  _saveHistory() {
    this.homey.settings.set('ems_history', this._emsHistory.slice(-EMS_HISTORY_MAX));
  },

  getEmsHistory() {
    // Return shallow clones of the entries — the caller (settings UI via the API)
    // must not be able to mutate the EMS's live history objects by reference.
    return this._emsHistory.slice(-EMS_HISTORY_MAX).map((e) => ({ ...e }));
  },

};
