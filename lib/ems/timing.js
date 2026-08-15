'use strict';

/**
 * Time budgets for the control loop. Mixed into EmsDevice.prototype; `this` is the device.
 *
 * Its own module rather than a corner of another one: the charger control needs it, the
 * simple devices need it, and neither should have to depend on the history mixin to get it.
 */

module.exports = {

  /**
   * Wait for `promise`, but not for longer than `ms`.
   *
   * Used on the flow triggers the loop fires. Every other await in a tick is already
   * bounded — the local-API client aborts at 8 s — but a trigger resolves through Homey's
   * flow engine, and what runs there is the user's own flows: a Modbus write queued behind
   * a polling cycle, another app being slow, anything at all.
   *
   * One field tick took 300 s against a 238 ms average. For those five minutes the EMS
   * controlled nothing — it neither turned the car down nor stopped it — and that is how a
   * charging session emptied the house battery while the loop sat waiting. Fifteen ticks
   * were skipped by that single one.
   *
   * The loop needs a trigger DISPATCHED, never completed; nothing downstream reads a
   * result. So when the budget is up we stop waiting and carry on. The flow itself keeps
   * running on Homey's side — only our willingness to block on it ends.
   *
   * Deliberately NOT a timeout around the whole tick. JavaScript cannot cancel a running
   * promise, so abandoning a tick would leave it alive to fire a five-minute-old decision
   * at the charger while a newer tick is already acting on fresh numbers. Bounding the one
   * unbounded await keeps exactly one tick in flight, which is what makes the loop
   * predictable in the first place.
   */
  _settleWithin(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = this.homey.setTimeout(() => {
        this.log(`[EMS] ${label}: no answer within ${ms} ms — not waiting any longer`);
        resolve();
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) this.homey.clearTimeout(timer);
    });
  },

};
