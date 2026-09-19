'use strict';

/**
 * The name a person sees for an enum capability's current value, in their own language.
 *
 * Mixed into a device prototype:
 *
 *     Object.assign(FooDevice.prototype, enumLabel);
 *
 * The names already exist, translated, in app.json — as the `values[].title` of each enum
 * capability. That is what Homey's own picker shows on the device tile, so reading them back
 * from the manifest is the only way a second place can be sure it says the same words. A
 * fourth copy in locales/*.json would have been a fourth thing to keep in step.
 *
 * `this.homey.manifest` is the app manifest; the owner's Luxtronik app reads
 * `this.homey.manifest.capabilities` the same way. Should a runtime ever hand back a
 * manifest without the enum values, the caller's own English map is used instead — the
 * result is then English rather than nothing, and the fallback maps are pinned complete by
 * test/enum-label.test.js so they cannot quietly grow a hole.
 */

module.exports = {

  /**
   * @param {string} capabilityId  e.g. 'storage_working_mode_settings'
   * @param {string|number|null} value  the capability's current value
   * @param {Object<string,string>} [fallback]  id → English name, used when the manifest
   *                                            cannot answer
   * @returns {string|null}  null when there is no value to name — never a made-up one
   */
  _enumLabel(capabilityId, value, fallback = {}) {
    if (value === null || value === undefined || value === '') return null;
    const key = String(value);

    let lang = 'en';
    try { lang = this.homey.i18n.getLanguage() || 'en'; } catch (_) { /* default stays */ }

    try {
      const values = this.homey.manifest.capabilities[capabilityId].values;
      const hit = values.find((v) => String(v.id) === key);
      // A title object with neither the user's language nor English in it is not a title.
      const title = hit && hit.title;
      if (title && (title[lang] || title.en)) return title[lang] || title.en;
    } catch (_) {
      // No manifest, no such capability, no values — fall through to the map below.
    }

    return fallback[key] || `Mode ${key}`;
  },

};
