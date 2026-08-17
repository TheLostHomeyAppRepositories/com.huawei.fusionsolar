'use strict';

/**
 * Per-device diagnostics: what the EMS measured this tick, beside what it believes.
 *
 * Mixed into EmsDevice.prototype; `this` is the device.
 *
 * The two columns are the point. Nearly every fault found in the field has lived in the
 * gap between them, not inside either one:
 *
 *   a charger drawing 8 kW while the EMS had it at currentAmps: null
 *   a session still open days after the last charge, because the cable never came out
 *   a heat pump the EMS believed running while its own controller had refused
 *   a stop command that never landed, so the EMS held a belief nothing shared
 *
 * A single column would have shown none of them. The summed figures already in the
 * diagnostics — grid, PV, SoC, house — show even less: they are what the decision was made
 * FROM, aggregated past the point where a single device can be seen at all.
 */

// Timers are absolute timestamps in the state maps. Ages are what a reader needs, and they
// stay meaningful in a report pasted somewhere hours later, which an epoch does not.
function ageS(ts, now) {
  return typeof ts === 'number' && ts > 0 ? Math.round((now - ts) / 1000) : null;
}

module.exports = {

  /**
   * One row per device the EMS steers. Devices it merely reads (meters, inverters) are
   * left out: their values are the summed figures already reported, and repeating them
   * per device would pad the export without adding anything.
   */
  _deviceDiag(now = Date.now()) {
    const readings = this._deviceReadings || [];
    const byId = new Map(readings.map((r) => [r.id, r]));
    const out = [];

    for (const [id, st] of (this._chargerStates || new Map())) {
      const r = byId.get(id);
      out.push({
        id, kind: 'charger',
        name: null, // chargers carry no name in ems_config; the settings page resolves it
        measured: r ? r.measured : null,
        ems: {
          // What was COMMANDED, which is the half a log line never shows.
          amps: st.currentAmps, phases: st.currentPhases,
          pendingAmps: st.pendingStepAmps, pendingForS: ageS(st.pendingStepSince, now),
          lastDownStepS: ageS(st.lastDownStepAt, now),
          lastPhaseSwitchS: ageS(st.lastPhaseSwitchAt, now),
          targetReachedCar: st.targetReachedCar || null,
          uncommandedTicks: st.uncommandedTicks || 0,
          sessionActive: !!st.sessionActive,
          sessionKwh: st.sessionActive ? Math.round((st.sessionEnergyKwh || 0) * 100) / 100 : null,
          sessionForS: st.sessionActive ? ageS(st.sessionStartedAt, now) : null,
        },
      });
    }

    for (const [kind, map] of Object.entries(this._simpleStateMaps ? this._simpleStateMaps() : {})) {
      if (!map) continue;
      for (const [id, st] of map) {
        const r = byId.get(id);
        out.push({
          id, kind,
          name: r ? r.name : null,
          measured: r ? r.measured : null,
          ems: {
            isOn: st.isOn ?? null,
            runningForS: st.isOn ? ageS(st.startedAt, now) : null,
            surplusOkForS: ageS(st.surplusOkSince, now),
            surplusBadForS: ageS(st.surplusBadSince, now),
            sinceEmsStopS: ageS(st.lastEmsStopAt, now),
            sincePowerDropS: ageS(st.powerDropStoppedAt, now),
            externalOn: st.externalOn === true,
          },
        });
      }
    }

    // Cars are neither measured nor commanded by the EMS, but a charge decision cannot be
    // read without them — "why did it stop" is answered by soc vs target more often than
    // by anything else in this file.
    for (const c of this._carStates || []) {
      out.push({ id: c.id, kind: 'car', name: c.name, measured: { soc: c.soc, target: c.target }, ems: null });
    }

    return out;
  },

};
