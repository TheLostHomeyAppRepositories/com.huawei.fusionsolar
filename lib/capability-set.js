'use strict';

/**
 * The guarded capability write every polling driver needs.
 *
 * Nothing here is protocol-specific, which is why it sat byte-identically in fifteen
 * drivers across the Modbus and OpenAPI families. It lives on its own rather than inside
 * lib/modbus-polling.js so the OpenAPI drivers can use it without pulling in polling
 * machinery they do not have — they are driven by lib/openapi-coordinator.js instead.
 *
 * Applied the same way as the other mixins in this repo:
 *
 *     const capabilitySet = require('../../lib/capability-set');
 *     Object.assign(FooDevice.prototype, capabilitySet);
 *
 * Three drivers deliberately keep their own version and are not touched:
 * energy_management, fusionsolar_kiosk and smartcharger_ocpp each need different
 * behaviour here.
 */

module.exports = {

  /**
   * Set `capability` to `value`, skipping the writes not worth making.
   *
   * Skips null/undefined rather than clearing the capability: a single missing register
   * in an otherwise good poll should leave the last known reading standing, and a poll
   * that fails as a whole takes the device unavailable, which says it more clearly than
   * a field going blank would.
   *
   * Skips unchanged values, so a meter reporting the same figure all night costs nothing.
   *
   * Never throws: a rejected write is logged and the poll carries on to the remaining
   * capabilities, instead of one bad field aborting the whole update.
   */
  async _set(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    try {
      await this.setCapabilityValue(capability, value);
    } catch (err) {
      this.log(`_set(${capability}, ${value}) failed:`, err.message);
    }
  },

};
