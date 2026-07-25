'use strict';

// EMS history + timeline notifications. Mixed into EmsDevice.prototype; `this` is
// the device instance. See drivers/energy_management/device.js.
const { EMS_HISTORY_MAX } = require('./constants');

module.exports = {

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
