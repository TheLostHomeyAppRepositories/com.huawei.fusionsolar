'use strict';

// Battery SOC zone helper. Mixed into EmsDevice.prototype; `this` is the device
// instance. Pure function of (cfg, battery) — kept as a mixin so it stays testable
// in isolation (see test/ems.test.js). Extracted from drivers/energy_management/device.js.

module.exports = {

  // Classifies the battery's state of charge into the EMS control zones:
  //   batHardStop — SOC below the low floor: controllable loads must go off (unless
  //                 an overflow exception applies at the call site).
  //   batReserve  — "orange" zone between the low floor and the normal minimum: loads
  //                 may run only on genuine surplus, not on battery power.
  // hasLowZone is true only when a distinct low floor (min_battery_soc_low) is
  // configured below the normal minimum. Without it, there is no reserve zone and
  // any SOC below min counts as a hard stop.
  /**
   * One threshold, not three. Below the hard stop no device runs and the battery charges
   * at full power; above it the surplus share ramp (below) decides how much the devices
   * may take. The middle "reserve" zone with its flat watt budget is gone — the ramp
   * covers that ground continuously.
   *
   * Derived from the old settings rather than migrated, so nothing has to be rewritten in
   * storage: the old hard stop was minSocLow when a reserve zone existed, otherwise minSoc.
   *
   * The returned shape is unchanged on purpose. chargerControl reads five of these fields —
   * batReserve suppresses the grid-charging tiers, batLow enters the restricted mode,
   * hasLowZone picks the threshold — and with the reserve zone permanently absent they all
   * still say the right thing without that file having to change.
   */
  _batteryZones(cfg, battery) {
    // One threshold. When the surplus ramp is configured its lower SOC point IS the stop
    // threshold: below it no device runs and the battery charges at full power, above it
    // the ramp decides the share. That makes "share 0 % at the lower point" mean what it
    // reads like — a zero budget alone would only withhold EXTRA power, leaving a running
    // device running on genuine export.
    //
    // Without a ramp, the old settings still define it: the hard stop was
    // min_battery_soc_low where a reserve zone existed, min_battery_soc otherwise.
    const rampLow = Number(cfg.share_soc_low ?? 0);
    const rampOn  = Number(cfg.share_soc_high ?? 0) > rampLow;
    const hardStop = rampOn ? rampLow : Number(
      (Number(cfg.min_battery_soc_low ?? 0) > 0 ? cfg.min_battery_soc_low : cfg.min_battery_soc) ?? 80,
    );
    // An unreadable state of charge HOLDS the stop; it does not release it.
    //
    // The old test was `battery.soc !== null && …`, so a missing reading made batHardStop
    // false and every controllable device was free to start. Seen in the field on
    // 2026-08-26 at 09:31 with the battery at 22 %: three devices entered start-sustain and
    // the mode dropped to idle, both of which mean the EMS did not see a low battery. Forty
    // seconds later the reading was back and the stop re-engaged. Had the surplus held for
    // the full minute, the pool would have started on a battery at 22 % — the exact thing
    // the setting exists to prevent.
    //
    // Releasing a protection because its input went missing is the wrong direction: the
    // owner asked for the battery to be protected below a level, and "I cannot see it" is
    // not "it is fine". device.js holds the last good reading for a minute before it reports
    // null at all (BATTERY_SOC_HOLD_MS), so what reaches here is a sustained absence, not a
    // dropped packet.
    //
    // Guarded by having a battery configured at all. Without that, an installation with no
    // battery — where soc is null by definition, not by failure — would stop every device
    // forever.
    const socKnown  = battery.soc !== null && battery.soc !== undefined;
    const hasBattery = ((cfg && cfg.battery_devices) || []).length > 0;
    const batHardStop = hardStop > 0
      && (socKnown ? battery.soc < hardStop : hasBattery);
    // Shape kept: chargerControl reads five of these — batReserve suppresses the
    // grid-charging tiers, batLow enters the restricted mode, hasLowZone picks the
    // threshold — and with no reserve zone they all still say the right thing.
    return {
      minSoc: hardStop, minSocLow: hardStop,
      hasLowZone: false,
      batLow: batHardStop,
      batReserve: false,
      batHardStop,
    };
  },

  /**
   * Share of the solar surplus the devices may claim, as a fraction 0..1, ramped linearly
   * with battery SOC between two configured points. Replaces the flat orange watt budget:
   * the closer the battery is to the upper SOC, the more of the surplus goes to devices
   * and the less to charging.
   *
   * Returns null when the ramp is not configured, so callers keep the old zone behaviour —
   * this is opt-in, existing installs are untouched until they set the two SOC points.
   */
  _batterySurplusShare(cfg, soc) {
    const socLo = Number(cfg.share_soc_low  ?? 0);
    const socHi = Number(cfg.share_soc_high ?? 0);
    if (!(socHi > socLo) || soc === null || soc === undefined) return null;
    const pctLo = Number(cfg.share_pct_low  ?? 0)   / 100;
    const pctHi = Number(cfg.share_pct_high ?? 100) / 100;
    // Below the lower point: nothing, not pctLo. That point is also the hard stop —
    // _batteryZones derives it from share_soc_low, which is what allowed the separate
    // hard-stop setting to go away — so any share down there described a state that
    // cannot occur, since every device is stopped anyway. It was not harmless: the budget
    // built from it still widened the effective surplus for whatever the hard stop did
    // not cover, and the settings preview read it back as "devices get 20% of production"
    // at a SoC where the chart right above it said "all off". The chart was right.
    if (soc < socLo) return 0;
    // Clamped above the upper point at pctHi — no extrapolation past that end either.
    const t = Math.min(1, Math.max(0, (soc - socLo) / (socHi - socLo)));
    return Math.min(1, Math.max(0, pctLo + t * (pctHi - pctLo)));
  },

  /**
   * How much MORE than the current grid export the devices may draw, in watts — the same
   * currency as the flat orange budget it replaced, so the tick loop is unchanged.
   *
   * The share applies to what the PV array is actually producing. Note what that means:
   * the house is served from the same production, so at a high house load a share of the
   * raw output can exceed what is genuinely free, and the difference is drawn from the
   * grid. That is deliberate — the whole-house grid import ceiling stays underneath as
   * the guard. Subtracting the current export is what keeps this a top-up rather than a
   * double count: the export is already reduced by whatever the battery is absorbing, and
   * that absorbed power is exactly what this budget lets a device claim instead.
   */
  /**
   * The two SOC points at which the EMS announces "battery low" / "battery full".
   *
   * With a surplus ramp configured they follow it: the lower point is where every device
   * stops and the battery takes everything, the upper is where the battery stops having
   * priority at all. Those are the two moments actually worth a notification, and they are
   * the ones a reader can see on the chart.
   *
   * Before this they were min_battery_soc / battery_full_soc, whose input fields went away
   * with the SOC zones in 1.2.108 — leaving the `?? 80` and `?? 95` defaults firing from
   * nowhere. On a system whose hard stop sits at 50 %, "53% < 80% — Batterie tief" reads
   * like a limit that stops something, and the owner reasonably asked what it governed.
   * Nothing. It now names a threshold that does.
   *
   * Installations without a ramp keep the old figures, so nothing moves for them.
   *
   * One caveat, stated rather than papered over: the upper ramp point is often 100, and
   * "full" then needs the battery to report exactly 100 %. Most do; one that stops at 99
   * would never announce full again. The remedy is the ramp's upper point, which is a
   * setting the user can see, rather than a hidden constant — which is the whole change.
   */
  _batteryAnnounceThresholds(cfg) {
    const socLo = Number(cfg.share_soc_low  ?? 0);
    const socHi = Number(cfg.share_soc_high ?? 0);
    if (socHi > socLo) return { lowSoc: socLo, fullSoc: socHi, source: 'ramp' };
    return {
      lowSoc:  Number(cfg.min_battery_soc  ?? 80),
      fullSoc: Number(cfg.battery_full_soc ?? 95),
      source:  'legacy',
    };
  },

  /**
   * "Have we already announced this?" — one flag pair per battery, persisted.
   *
   * _batteryStates lived in memory only, so every restart forgot it and the next tick
   * re-announced a threshold that had been crossed hours earlier. Visible in the field on
   * 2026-08-16: "66% < 80% — Batterie tief" at 23:04 and again at 23:05, once per app
   * start, either side of a deploy. Two of the day's four announcements were restart
   * artefacts, and any flow hanging off ems_battery_low ran for nothing.
   *
   * Deliberately WITHOUT the staleness rule the charger and simple-device states carry.
   * There is nothing here that goes out of date: the flags describe what the user has been
   * told, and _checkBatteryTriggers clears each one as soon as the SOC moves 5 points back
   * across its threshold. If the app was away for two days and the battery is still low,
   * staying quiet is the correct answer, not a stale one — and the next genuine crossing
   * re-arms itself.
   */
  async _restoreBatteryStates() {
    let stored = null;
    try { stored = await this.getStoreValue('batteryStates'); } catch (_) { return; }
    if (!stored || typeof stored !== 'object') return;
    for (const [id, st] of Object.entries(stored)) {
      if (!st || typeof st !== 'object') continue;
      // Only the two announcement flags. priceMode lives on the same entry and is tempting
      // to carry along — it too re-fires after a restart — but it is a different kind of
      // thing: an announcement the user missed costs nothing, while priceMode is a COMMAND
      // to the battery that the EMS cannot read back. Restoring it would mean believing a
      // working mode we never verified, which is the mistake that cost a house battery in
      // July with the charger's currentAmps. Re-commanding on restart is the safe direction.
      this._batteryStates.set(id, {
        fullFired: st.fullFired === true,
        lowFired:  st.lowFired === true,
      });
    }
  },

  _saveBatteryStates() {
    const out = {};
    for (const [id, st] of this._batteryStates.entries()) {
      out[id] = { fullFired: !!st.fullFired, lowFired: !!st.lowFired };
    }
    // Only on change: the flags move a handful of times a day, the tick runs every 20 s.
    const body = JSON.stringify(out);
    if (body === this._lastBatteryStateJson) return false;
    this._lastBatteryStateJson = body;
    this.setStoreValue('batteryStates', out).catch(() => {});
    return true;
  },

  _batteryShareBudgetW(cfg, soc, pvW, gridW, batteryW = null) {
    const share = this._batterySurplusShare(cfg, soc);
    if (share === null || pvW === null || gridW === null) return null;
    const exportW = Math.max(0, -gridW);
    const claimW  = Math.max(0, Math.round(Math.max(0, pvW) * share - exportW));
    // The budget's own rationale, enforced: what this lets a device claim beyond the real
    // export is "exactly what the battery is absorbing" (see the doc comment above). So it
    // can never exceed what the battery is absorbing — and while the battery DISCHARGES it
    // is absorbing nothing, yet the formula alone still granted pv × share.
    //
    // Measured on 2026-08-18, 17:05–17:16: SoC 60 % → 20 % of ~7 kW ≈ 1.4 kW granted while
    // the battery was discharging. That kept one rung of permanent headroom in the charger
    // budget, so it climbed 12A/1ph → 10A/3ph (1.6 → 6.9 kW) in eleven minutes, financed
    // entirely by the battery (↓3521 W at the top). No other guard could catch it: the
    // inverter holds the meter at ~0 during discharge, so the import guard and the
    // discharge correction — both keyed on actual grid import — were blind.
    //
    // Without a battery power sensor (batteryW null) the cap cannot be computed and the
    // old behaviour stands: capping on a guess would be worse than not capping.
    if (typeof batteryW !== 'number') return claimW;
    return Math.min(claimW, Math.max(0, Math.round(batteryW)));
  },

};
