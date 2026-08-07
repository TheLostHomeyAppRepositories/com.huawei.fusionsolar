'use strict';

// EMS chargerControl methods. Mixed into EmsDevice.prototype; `this` is the device
// instance. Extracted from drivers/energy_management/device.js.
const {
  AMPS_LADDER, STEP_HOLD_MS, IMPORT_HOLD_MS, FLIP_COOLDOWN_MS, PHASE_SWITCH_COOLDOWN_MS,
  IMPORT_ACT_W, EXPORT_GUARD_W, UP_MARGIN_W, MIN_3PH_W, MIN_CHARGE_W, MODES, HIST,
} = require('./constants');

module.exports = {

  _getChargerState(id) {
    if (!this._chargerStates.has(id)) {
      this._chargerStates.set(id, {
        currentAmps:       null,
        currentPhases:     null,
        pendingStepAmps:   null,
        pendingStepSince:  null,
        lastDownStepAt:    null,
        lastPhaseSwitchAt: null,
        targetReachedCar:  null, // carId whose charge target is reached (hold until unplug)
      });
    }
    return this._chargerStates.get(id);
  },

  async _chargerStop(id) {
    this.log(`[EMS] charger ${id}: stop`);
    this._addHistoryEvent(HIST.CHARGER, 'stop', '0A', id);
    this.log(`[EMS] charger ${id}: stop → trigger ems_set_charger_current (0A)`);
    await this.homey.flow
      .getTriggerCard('ems_set_charger_current')
      .trigger({ amps: 0, phase1: 0, phase2: 0, phase3: 0, charger_device_id: id }, { charger_device_id: id })
      .catch((e) => this.log(`[EMS] charger ${id}: stop trigger failed: ${e.message}`));
    const st = this._getChargerState(id);
    st.currentAmps = null; st.pendingStepAmps = null; st.pendingStepSince = null;
    st.currentPhases = null;
    st.lastDownStepAt = Date.now(); // always apply FLIP_COOLDOWN_MS after any stop
  },

  async _chargerSetAmps(id, amps, phases) {
    const st = this._getChargerState(id);

    if (st.currentAmps === null) {
      this.log(`[EMS] charger ${id}: → trigger ems_start_charger`);
      await this.homey.flow
        .getTriggerCard('ems_start_charger')
        .trigger({ charger_device_id: id }, { charger_device_id: id })
        .catch((e) => this.log(`[EMS] charger ${id}: start trigger failed: ${e.message}`));
    }

    const p1 = amps;
    const p2 = phases >= 2 ? amps : 0;
    const p3 = phases >= 3 ? amps : 0;
    const prevAmps = st.currentAmps;
    if (prevAmps === null || prevAmps !== amps) {
      this._addHistoryEvent(HIST.CHARGER, prevAmps === null ? 'start' : 'set_amps', `${amps}A/${phases}ph`, id);
    }
    this.log(`[EMS] charger ${id}: ${amps}A / ${phases}ph (L1=${p1} L2=${p2} L3=${p3}) → trigger ems_set_charger_current`);
    await this.homey.flow
      .getTriggerCard('ems_set_charger_current')
      .trigger({ amps, phase1: p1, phase2: p2, phase3: p3, charger_device_id: id }, { charger_device_id: id })
      .catch((e) => this.log(`[EMS] charger ${id}: set trigger failed: ${e.message}`));
    st.currentAmps   = amps;
    st.currentPhases = phases; // always track phases so phase-switch logic sees correct state next tick
  },

  _bestPhases(budgetW) {
    return budgetW >= MIN_3PH_W ? 3 : 1;
  },

  // Shared grid-import budget for price-driven grid-charging (cfg.price_charge_max_grid_kw,
  // 0/unset = unlimited). this._priceChargeCommittedW is reset once per tick in
  // device.js _tickBody, then claimed here (P3b/P3c) and in _checkBatteryPriceControl —
  // whichever runs first (the battery does) gets first claim. Returns whether the
  // requested power fits; if it does, claims it (mutates the running total).
  _priceChargeClaimBudget(cfg, chargerPowerW) {
    const maxGridKw = Number(cfg.price_charge_max_grid_kw) || 0;
    if (maxGridKw <= 0) return true; // unlimited — no tracking needed
    const committed = this._priceChargeCommittedW || 0;
    if (committed + chargerPowerW > maxGridKw * 1000) return false;
    this._priceChargeCommittedW = committed + chargerPowerW;
    return true;
  },

  // Highest amp rung (≤ desiredAmps) whose draw still fits what is LEFT of the shared
  // price-charge budget — pure, claims nothing. Lets P3b/P3c bound their request before
  // claiming either budget, so no claim ever has to be rolled back: previously the full
  // theoretical max was claimed here first and then silently abandoned (never released)
  // whenever the whole-house ceiling subsequently granted fewer amps, or none at all.
  // Returns desiredAmps when no price budget is configured, 0 when nothing fits.
  _priceChargeCapAmps(cfg, desiredAmps, phases) {
    const maxGridKw = Number(cfg.price_charge_max_grid_kw) || 0;
    if (maxGridKw <= 0) return desiredAmps; // unlimited — no capping needed
    const headroomW = maxGridKw * 1000 - (this._priceChargeCommittedW || 0);
    let capped = 0;
    for (const a of AMPS_LADDER) { if (a <= desiredAmps && a * phases * 230 <= headroomW) capped = a; }
    return capped;
  },

  // Whole-house grid-import ceiling (cfg.grid_import_limit_kw, 0/unset = unlimited) —
  // a hard main-fuse safety limit, distinct from and layered UNDER price_charge_max_grid_kw
  // (which only budgets price-driven charging specifically). this._gridImportCommittedW is
  // seeded once per tick in device.js _tickBody to the ALREADY-measured grid import (so
  // ordinary house baseline load is accounted for), then every unconditional-draw tier
  // (Instant/Always/Off-peak here, price/low-tariff charging and battery force-charge
  // elsewhere) claims against it as it runs. Unlike _priceChargeClaimBudget (binary
  // accept/reject), this GRACEFULLY reduces to the highest amp-ladder rung that still
  // fits — better to charge slower than to stop outright when only just over the limit.
  // Returns the granted amps (0 if even the minimum doesn't fit — charger should stop).
  //
  // `currentDrawW` is what THIS charger is already drawing. It matters because the
  // running total is seeded (device.js _tickBody) from the MEASURED grid import, which
  // already contains that draw — so claiming the new target on top of it would count the
  // same charger twice. That is exactly what used to happen: a charger sitting well
  // inside the ceiling was stopped, its draw then left the meter reading, the next tick
  // saw plenty of headroom and started it again — a permanent 15 s start/stop cycle.
  // The claim is therefore a DELTA: take this charger's own draw back out before
  // measuring headroom, then add back only what is granted. (The on/off simple devices
  // in simpleDevices.js never hit this because they only ever claim on a NEW start.)
  _gridImportClaimAmps(cfg, minAmps, desiredAmps, phases, currentDrawW = 0) {
    const limitKw = Number(cfg.grid_import_limit_kw) || 0;
    if (limitKw <= 0) return desiredAmps; // unlimited — no tracking needed
    const committed  = this._gridImportCommittedW || 0;
    const baselineW  = committed - Math.max(0, currentDrawW);
    // Deliberately NOT clamped at 0: when the house is already over the ceiling the
    // headroom is negative, which correctly forces a step DOWN instead of leaving the
    // charger at its current amps.
    const headroomW  = limitKw * 1000 - baselineW;
    const ladder     = AMPS_LADDER.filter((a) => a >= minAmps && a <= desiredAmps);
    let granted = 0;
    for (const a of ladder) { if (a * phases * 230 <= headroomW) granted = a; }
    this._gridImportCommittedW = baselineW + granted * phases * 230;
    return granted;
  },

  // Binary variant of _gridImportClaimAmps for on/off devices (heat pump, boiler, pool,
  // dehumidifier) that have no amp ladder to gracefully reduce — either the fixed power
  // fits under the ceiling or the start is denied outright. Shares the same tick-scoped
  // this._gridImportCommittedW bookkeeping as the graceful EV-charger version above and
  // the battery force-charge check in device.js _checkBatteryPriceControl.
  _gridImportClaimFixed(cfg, powerW) {
    const limitKw = Number(cfg.grid_import_limit_kw) || 0;
    if (limitKw <= 0) return true; // unlimited — no tracking needed
    const committed = this._gridImportCommittedW || 0;
    if (committed + powerW > limitKw * 1000) return false;
    this._gridImportCommittedW = committed + powerW;
    return true;
  },

  // Instant charging is a toggle the user turns on deliberately; nothing but this clears
  // it again. Unplugging is the one end-of-charge signal every setup has — target SOC is
  // only known when the vehicle exposes it. Without this the toggle would still be on the
  // next time a car is plugged in and would immediately charge it at full power.
  async _clearChargeNowWhenUnplugged(chargers) {
    if (this.getCapabilityValue('charge_now') !== true) return;
    if ((chargers || []).some((c) => c.connected)) return;
    this.log('[EMS] instant charging: no charger connected any more → switching off');
    await this.setCapabilityValue('charge_now', false).catch(() => {});
  },

  async _evaluateEvChargers(battery, gridW, chargers, cfg, pvW = null, houseW = null) {
    await this._clearChargeNowWhenUnplugged(chargers);
    if (!chargers.length) return 0;
    if (cfg.charger_control === false) return 0;
    // Per-device "EMS controls this device" toggle (set via the ems-device
    // widget or Settings) — a charger with enabled===false is left alone
    // entirely: no start/stop/amp commands, not counted in the surplus-sharing
    // loop below. Any charging it does anyway (manual/external) still shows up
    // in the grid meter reading and is still logged as a charge session — see
    // device.js _tickBody, which tracks sessions independent of this filter.
    chargers = chargers.filter((c) => c.enabled !== false);
    if (!chargers.length) return 0;
    const { minSoc, minSocLow, hasLowZone, batLow, batReserve } = this._batteryZones(cfg, battery);
    const now = Date.now();

    let anyConnected = chargers.some((c) => c.connected);
    let totalW       = chargers.reduce((s, c) => s + c.powerW, 0);

    // ── P0: Instant charging ─────────────────────────────────────────────────
    if (this.getCapabilityValue('charge_now') === true) {
      if (!anyConnected) {
        const p0SocStr = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
        await this._setMode(MODES.IDLE, `kein EV verbunden${p0SocStr}`);
        return 0;
      }
      const instantGranted = [];
      for (const c of chargers) {
        if (!c.connected) continue;
        // A phase-switching charger runs 3-phase here, same as every other tier
        // (P3/P3b/P3c) — instant charging wants maximum power.
        const phases = c.phaseSwitch ? 3 : c.phases;
        const grantedAmps = this._gridImportClaimAmps(cfg, c.minAmps, c.maxAmps, phases, c.powerW);
        const st = this._getChargerState(c.id);
        if (grantedAmps <= 0) {
          if (st.currentAmps !== null) await this._chargerStop(c.id);
          continue;
        }
        if (this._warmupDone && (st.currentAmps !== grantedAmps || st.currentPhases !== phases)) {
          await this._chargerSetAmps(c.id, grantedAmps, phases);
        }
        instantGranted.push({ c, amps: grantedAmps, phases });
      }
      const parts = instantGranted.map(({ amps, phases }) => `${amps}A/${phases}ph`).join(' + ');
      await this._setMode(MODES.INSTANT_EV, parts);
      return instantGranted.reduce((s, { amps, phases }) => s + amps * phases * 230, 0);
    }

    // ── P0.5: "Always charge" mode ───────────────────────────────────────────
    // Charges at max power as soon as the cable is in — independent of solar and
    // battery state (same standing as instant charging). These chargers are then
    // removed from the solar/off-peak logic below.
    let alwaysW = 0;
    const alwaysGrantedAmps = new Map(); // c.id → { amps, phases } granted, for the status text below
    const alwaysChargers = chargers.filter((c) => c.chargeMode === 'always');
    if (alwaysChargers.length) {
      for (const c of alwaysChargers) {
        const st = this._getChargerState(c.id);
        if (!c.connected) {
          if (st.currentAmps !== null) await this._chargerStop(c.id);
          continue;
        }
        // Phase-switching charger runs 3-phase, same as every other tier (see P0).
        const phases = c.phaseSwitch ? 3 : c.phases;
        const grantedAmps = this._gridImportClaimAmps(cfg, c.minAmps, c.maxAmps, phases, c.powerW);
        if (grantedAmps <= 0) {
          if (st.currentAmps !== null) await this._chargerStop(c.id);
          continue;
        }
        if (this._warmupDone && (st.currentAmps !== grantedAmps || st.currentPhases !== phases)) {
          await this._chargerSetAmps(c.id, grantedAmps, phases);
        }
        alwaysGrantedAmps.set(c.id, { amps: grantedAmps, phases });
        alwaysW += grantedAmps * phases * 230;
      }
      chargers = chargers.filter((c) => c.chargeMode !== 'always');
      if (!chargers.length) {
        const connAlways = alwaysChargers.filter((c) => c.connected && alwaysGrantedAmps.has(c.id));
        if (!connAlways.length) {
          const aSocStr = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
          await this._setMode(MODES.IDLE, `kein EV verbunden${aSocStr}`);
          return 0;
        }
        const aParts = connAlways.map((c) => {
          const g = alwaysGrantedAmps.get(c.id);
          return `${g.amps}A/${g.phases}ph`;
        }).join(' + ');
        await this._setMode(MODES.INSTANT_EV, `Immer laden · ${aParts}`);
        return alwaysW;
      }
      // Recompute for the remaining (solar-managed) chargers
      anyConnected = chargers.some((c) => c.connected);
      totalW       = chargers.reduce((s, c) => s + c.powerW, 0);
    }

    // ── P1: Battery priority ─────────────────────────────────────────────────
    // Three zones based on SOC vs. two thresholds (min_soc_low < min_soc):
    //   soc ≥ min_soc               → normal operation
    //   min_soc_low ≤ soc < min_soc → orange zone: devices share orange budget
    //   soc < min_soc_low           → hard stop (with overflow exception for grid export)
    let batOverflowMode = false;
    let batReserveMode = false;

    if (batLow) {
      if (batReserve) {
        // Orange zone: devices share the orange budget; battery keeps solar priority
        batReserveMode = true;
      } else {
        // Hard stop zone: soc < minSocLow (or no low zone configured)
        const batCharging    = battery.powerW !== null && battery.powerW > 0;
        const exportSurplusW = gridW !== null ? -gridW : 0;

        // Hysteresis: require 2×MIN_CHARGE_W export to START overflow charging but only
        // ½×MIN_CHARGE_W to CONTINUE. Without this, starting the charger reduces the
        // apparent export (the EV wasn't yet drawing when the budget was computed), which
        // causes the condition to flip false on the very next tick → start/stop oscillation.
        const anyChargerRunning = chargers.some(
          (c) => (this._getChargerState(c.id).currentAmps ?? 0) > 0,
        );
        const overflowThreshold = anyChargerRunning ? MIN_CHARGE_W / 2 : MIN_CHARGE_W * 2;
        const hasOverflow       = batCharging && exportSurplusW >= overflowThreshold;

        if (!hasOverflow) {
          // Only stop chargers that EMS has running — avoids repeated stop triggers each tick
          for (const c of chargers) {
            if (this._getChargerState(c.id).currentAmps !== null) await this._chargerStop(c.id);
          }
          const socLimit  = hasLowZone ? minSocLow : minSoc;
          const stTextBat = `${Math.round(battery.soc)}% < ${socLimit}%`;
          await this._setMode(MODES.BATTERY_PRIORITY, stTextBat);
          return alwaysW;
        }
        batOverflowMode = true;
      }
    }

    // ── P2: No EV connected ──────────────────────────────────────────────────
    if (!anyConnected) {
      this._importSince = null;
      for (const c of chargers) {
        const st = this._getChargerState(c.id);
        st.targetReachedCar = null; // cable out → clear the "target reached" hold
        if (st.currentAmps !== null) await this._chargerStop(c.id);
      }
      const idleSocStr      = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
      const idleSurplusW    = gridW !== null ? Math.round(-gridW) : null;
      const idleSurplusStr  = idleSurplusW !== null && idleSurplusW > 0
        ? `${idleSurplusW} W Überschuss${idleSocStr}`
        : `kein Überschuss${idleSocStr}`;
      await this._setMode(MODES.IDLE, idleSurplusStr);
      return alwaysW;
    }

    // ── P2.5: Charge target reached ──────────────────────────────────────────
    // The car is still plugged in but already at its configured target. Without
    // this the EMS keeps re-tuning amps against a car that no longer draws —
    // for the whole afternoon, as long as surplus exists. Hold until the cable
    // is unplugged (cleared in P2 above) or the target is raised.
    // Resolve each charger's car (explicit car_id mapping, else heuristic) and hold
    // THAT charger when ITS car is at target — without stopping a charger whose car
    // is still below target. Freed surplus stays in the budget for the other chargers.
    for (const c of chargers) {
      if (!c.connected) continue;
      const st  = this._getChargerState(c.id);
      const car = this._carForCharger(c);
      if (car && car.soc !== null && car.target !== null) {
        if (car.soc >= car.target) {
          if (st.targetReachedCar !== car.id) {
            this.log(`[EMS] charger ${c.id}: "${car.name}" reached target ${car.target}% (now ${car.soc}%) — holding until unplug`);
            this._addHistoryEvent(HIST.CHARGER, 'target_reached', `${car.name} ${car.soc}% ≥ ${car.target}%`, c.id);
          }
          st.targetReachedCar = car.id;
        } else if (car.soc < car.target - 2) {
          st.targetReachedCar = null; // target raised or battery drained → resume
        }
      }
    }
    // Stop the chargers holding at target.
    const heldChargers = chargers.filter((c) => c.connected && this._getChargerState(c.id).targetReachedCar);
    for (const c of heldChargers) {
      if (this._getChargerState(c.id).currentAmps !== null) await this._chargerStop(c.id);
    }
    const connectedCount = chargers.filter((c) => c.connected).length;
    if (connectedCount && heldChargers.length === connectedCount) {
      // Every connected charger is at target → nothing left to manage.
      const tSocStr = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
      const heldCar = this._carForCharger(heldChargers[0]);
      const stTextTarget = heldCar
        ? `${heldCar.name}: Ladeziel erreicht (${Math.round(heldCar.soc)}% ≥ ${Math.round(heldCar.target)}%) — wartet auf Abstecken${tSocStr}`
        : `Ladeziel erreicht — wartet auf Abstecken${tSocStr}`;
      await this._setMode(MODES.HOLDING, stTextTarget);
      return alwaysW;
    }
    // Some (not all) chargers held → keep them out of the off-peak/solar allocation
    // below. totalW is intentionally NOT recomputed: the freed power stays as budget
    // for the remaining chargers.
    if (heldChargers.length) {
      chargers = chargers.filter((c) => !(c.connected && this._getChargerState(c.id).targetReachedCar));
    }

    // ── P3: Off-peak ──────────────────────────────────────────────────────────
    const offpeakWin = this._offpeakWindow(cfg);
    // Off-peak applies to chargers in "Solar & off-peak window" mode. The global
    // offpeak_enabled tile toggle still works as a legacy/global enable — but only
    // for chargers left on the default 'solar' mode. A charger explicitly set to a
    // different price-aware mode (solar_price / solar_lowtariff) made a deliberate
    // choice; the global toggle must not silently override it.
    const offpeakChargers = chargers.filter((c) => c.connected
      && (c.chargeMode === 'solar_offpeak' || (c.chargeMode === 'solar' && this.getCapabilityValue('offpeak_enabled') === true)));
    if (!batOverflowMode && !batReserveMode && offpeakChargers.length && offpeakWin.active) {
      // Solar-first: if there's enough export surplus to cover the minimum step,
      // let the solar logic handle it — free energy outranks cheap grid energy.
      const solarFirst    = cfg.offpeak_solar_first !== false; // default true
      // Threshold scales with the actual chargers present: hand off to solar only once
      // export surplus can cover the *smallest* off-peak charger's minimum draw (a
      // phase-switching charger can drop to 1-phase, a fixed 3-phase one cannot). A flat
      // MIN_CHARGE_W would hand off on 1380 W even when every charger needs 4140 W (3ph),
      // leaving them idle instead of using cheap off-peak power.
      const minClaimW     = Math.min(...offpeakChargers.map((c) => c.minAmps * (c.phaseSwitch ? 1 : c.phases) * 230));
      const solarCanClaim = solarFirst && gridW !== null && gridW <= -minClaimW;

      if (!solarCanClaim) {
        this._importSince = null; // clear stale import timer so solar mode starts fresh after off-peak
        const opAmps = offpeakWin.amps;
        const offpeakGranted = [];
        for (const c of offpeakChargers) {
          const opPhases   = c.phaseSwitch ? 3 : c.phases;
          const st         = this._getChargerState(c.id);
          const grantedAmps = this._gridImportClaimAmps(cfg, c.minAmps, opAmps, opPhases, c.powerW);
          if (grantedAmps <= 0) {
            if (st.currentAmps !== null) await this._chargerStop(c.id);
            continue;
          }
          if (this._warmupDone && (st.currentAmps !== grantedAmps || st.currentPhases !== opPhases)) {
            await this._chargerSetAmps(c.id, grantedAmps, opPhases);
            if (c.phaseSwitch) st.lastPhaseSwitchAt = now;
          }
          offpeakGranted.push({ c, amps: grantedAmps, phases: opPhases });
        }
        const stTextOffpeak = offpeakGranted.map(({ amps }) => amps).join('/') + `A × ${offpeakGranted.length} Lader`;
        await this._setMode(MODES.OFFPEAK_EV, stTextOffpeak);
        return alwaysW + offpeakGranted.reduce((s, { amps, phases }) => s + amps * phases * 230, 0);
      }
      // else: solar has surplus — fall through to solar surplus logic below
    }

    // ── P3b: Price-optimised charging (D10) ─────────────────────────────────────
    // Chargers in "Solar & price-optimised" mode. Unlike the fixed off-peak window
    // above, the "charge now" decision comes from _priceShouldChargeNow (per charger's
    // assigned car): it nets the Solcast PV forecast off the car's remaining energy
    // need, then — only for what solar won't cover — checks whether now is one of the
    // cheapest price slots before the car's deadline. A charger this tick decides NOT
    // to charge simply falls through to the normal solar-surplus loop below, so it
    // still benefits from any live surplus while waiting for a cheaper grid slot.
    const priceChargers = chargers.filter((c) => c.connected && c.chargeMode === 'solar_price');
    if (!batOverflowMode && !batReserveMode && priceChargers.length) {
      const solarFirst    = cfg.offpeak_solar_first !== false; // default true, same knob as off-peak
      const minClaimW     = Math.min(...priceChargers.map((c) => c.minAmps * (c.phaseSwitch ? 1 : c.phases) * 230));
      const solarCanClaim = solarFirst && gridW !== null && gridW <= -minClaimW;

      const chargingNow = [];
      if (!solarCanClaim) {
        for (const c of priceChargers) {
          const car           = this._carForCharger(c);
          const phases        = c.phaseSwitch ? 3 : c.phases;
          const chargerPowerW = c.maxAmps * phases * 230;
          const decision = this._priceShouldChargeNow(car, chargerPowerW, cfg, now);
          this._debugLog(`charger ${c.id} (solar_price): ${decision.shouldCharge ? 'wants' : 'not'} to charge — ${decision.reason}`);
          if (!decision.shouldCharge) continue;
          // Both budgets bound the request BEFORE either is claimed, so no claim can be
          // left stranded: first the shared price-charge budget (cfg.price_charge_max_grid_kw
          // — what's left after the battery's own committed price-charging earlier this
          // tick and any charger already fitted here), then the whole-house main-fuse
          // ceiling, which reduces further. Both are finally claimed for exactly the amps
          // granted. The old order claimed the theoretical MAX against the price budget up
          // front and never released it when the ceiling then granted fewer amps (or none),
          // exhausting the budget far faster than reality and wrongly denying later chargers.
          const priceCapAmps = this._priceChargeCapAmps(cfg, c.maxAmps, phases);
          if (priceCapAmps < c.minAmps) {
            this._debugLog(`charger ${c.id}: grid-charge budget DENIED — no budget left`);
            continue;
          }
          const grantedAmps = this._gridImportClaimAmps(cfg, c.minAmps, priceCapAmps, phases, c.powerW);
          if (grantedAmps <= 0) continue;
          const grantedW = grantedAmps * phases * 230;
          this._priceChargeClaimBudget(cfg, grantedW); // fits by construction (≤ priceCapAmps)
          this._debugLog(`charger ${c.id}: grid-charging at ${grantedAmps}A/${phases}ph (${grantedW}W)`);
          chargingNow.push({ c, phases, amps: grantedAmps });
        }
      }
      if (chargingNow.length) {
        this._importSince = null; // clear stale import timer so solar mode starts fresh afterwards
        for (const { c, phases, amps } of chargingNow) {
          const st = this._getChargerState(c.id);
          if (this._warmupDone && (st.currentAmps !== amps || st.currentPhases !== phases)) {
            await this._chargerSetAmps(c.id, amps, phases);
            if (c.phaseSwitch) st.lastPhaseSwitchAt = now;
          }
        }
        const stTextPrice = `${chargingNow.length} Lader · günstiger Strompreis`;
        await this._setMode(MODES.PRICE_EV, stTextPrice);
        return alwaysW + chargingNow.reduce((s, { amps, phases }) => s + amps * phases * 230, 0);
      }
      // else: no price-charger needs grid charging right now — fall through so they
      // still get solar surplus (and any others aren't affected).
    }

    // ── P3c: Low-tariff window (dual "Low / high tariff" price model) ──────────
    // Chargers in "Solar & low tariff" mode. Unlike the fixed Off-Peak Charging window
    // above (P3), this reuses the weekday high/low windows already configured under
    // Electricity Price → Low / high tariff — charges at full power whenever that
    // schedule says the LOW tariff currently applies. No effect if the tariff model
    // isn't set to "dual" or no window is configured for today.
    const lowTariffChargers = chargers.filter((c) => c.connected && c.chargeMode === 'solar_lowtariff');
    if (!batOverflowMode && !batReserveMode && lowTariffChargers.length) {
      const dual = this._dualTariffWindow(cfg);
      this._debugLog(`low-tariff chargers: dual-tariff ${dual.configured ? (dual.isHigh ? 'HIGH now' : 'LOW now') : 'not configured'}`);
      if (dual.configured && !dual.isHigh) {
        const solarFirst    = cfg.offpeak_solar_first !== false; // default true, same knob as off-peak
        const minClaimW     = Math.min(...lowTariffChargers.map((c) => c.minAmps * (c.phaseSwitch ? 1 : c.phases) * 230));
        const solarCanClaim = solarFirst && gridW !== null && gridW <= -minClaimW;

        if (!solarCanClaim) {
          // Shared grid-import budget — same as P3b: a low-tariff charger that doesn't
          // fit what's left of cfg.price_charge_max_grid_kw (after the battery's own
          // committed price-charging and any charger already fitted above) skips
          // grid-charging this tick and falls through to the normal solar loop.
          const fitting = [];
          for (const c of lowTariffChargers) {
            const phases = c.phaseSwitch ? 3 : c.phases;
            // Same bound-then-claim order as P3b — see the rationale there.
            const priceCapAmps = this._priceChargeCapAmps(cfg, c.maxAmps, phases);
            if (priceCapAmps < c.minAmps) {
              this._debugLog(`charger ${c.id}: grid-charge budget DENIED — no budget left`);
              continue;
            }
            const grantedAmps = this._gridImportClaimAmps(cfg, c.minAmps, priceCapAmps, phases, c.powerW);
            if (grantedAmps <= 0) continue;
            const grantedW = grantedAmps * phases * 230;
            this._priceChargeClaimBudget(cfg, grantedW); // fits by construction (≤ priceCapAmps)
            this._debugLog(`charger ${c.id}: grid-charging at ${grantedAmps}A/${phases}ph (${grantedW}W)`);
            fitting.push({ c, phases, amps: grantedAmps });
          }
          if (fitting.length) {
            this._importSince = null; // clear stale import timer so solar mode starts fresh after low tariff
            for (const { c, phases, amps } of fitting) {
              const st = this._getChargerState(c.id);
              if (this._warmupDone && (st.currentAmps !== amps || st.currentPhases !== phases)) {
                await this._chargerSetAmps(c.id, amps, phases);
                if (c.phaseSwitch) st.lastPhaseSwitchAt = now;
              }
            }
            const stTextLowTariff = `${fitting.length} Lader · Niedertarif`;
            await this._setMode(MODES.LOWTARIFF_EV, stTextLowTariff);
            return alwaysW + fitting.reduce((s, { amps, phases }) => s + amps * phases * 230, 0);
          }
          // else: nothing fit the remaining budget — fall through to solar surplus logic below
        }
        // else: solar has surplus — fall through to solar surplus logic below
      }
      // else: not currently low tariff (or not configured) — falls through to solar loop
    }

    // ── Import guard (60 s) ───────────────────────────────────────────────────
    const importing       = gridW !== null && gridW >= IMPORT_ACT_W;
    this._importSince     = importing ? (this._importSince ?? now) : null;
    const sustainedImport = importing && (now - this._importSince) >= IMPORT_HOLD_MS;
    if (sustainedImport) this._importSince = null;

    // ── Solar surplus allocation ───────────────────────────────────────────────
    // Battery correction: penalise EV budget only when battery is discharging AND
    // grid is importing — both sources draining simultaneously is too much EV load.
    // When grid is still exporting, solar surplus exists and the inverter manages
    // the battery itself; applying correction here caused start/stop oscillation.
    const batDischarging = battery.powerW !== null && battery.powerW < 0;
    const batCharging    = battery.powerW !== null && battery.powerW > 0;
    const batCorr  = batDischarging && gridW !== null && gridW > 0 ? battery.powerW : 0;
    let budgetW    = totalW - (gridW ?? 0) + batCorr;

    // Green zone: battery is charging from solar → that power is also available to the EV
    // charger. The inverter reduces battery charging proportionally when the charger draws
    // more, so battery charging wattage counts as additional budget (= 100% solar − house).
    // This handles the common case where all PV flows into the battery (grid ≈ 0W) and the
    // grid-based budget alone would read near zero, preventing the charger from starting.
    if (!batOverflowMode && !batReserveMode && batCharging) budgetW += battery.powerW;

    // PV-based cross-check: pvW − houseW converges to the same value as the battery-boost
    // above when sensors are accurate, but takes precedence if it reads higher (handles
    // sensor lag or setups without a battery power sensor).
    if (!batOverflowMode && pvW !== null && houseW !== null) {
      const pvBudgetW = Math.max(0, pvW - houseW);
      if (pvBudgetW > budgetW) {
        this.log(`[EMS] PV budget ${Math.round(pvBudgetW)}W > battery-boost budget ${Math.round(budgetW)}W — using PV`);
        budgetW = pvBudgetW;
      }
    }

    // Orange zone: budget already expanded by orangeBudget via effectiveGridW (injected in main tick).
    // No override needed; batReserveMode only suppresses battery-boost addition below.

    // In overflow mode keep the budget below the 3-phase threshold so _stepCharger never
    // triggers a 1ph→3ph switch. That switch doubles the charger draw instantly, which
    // pulls the battery out of charging and breaks the overflow condition on the next tick.
    if (batOverflowMode) budgetW = Math.min(budgetW, MIN_3PH_W - 1);

    const statuses = [];

    for (const charger of chargers) {
      if (!charger.connected) {
        if (this._getChargerState(charger.id).currentAmps !== null) await this._chargerStop(charger.id);
        continue;
      }
      const result = await this._stepCharger(charger, budgetW, charger.phases, now, gridW, sustainedImport);
      statuses.push(result);
      budgetW = Math.max(0, budgetW - result.allocatedW);
    }

    // ── Mode & status ────────────────────────────────────────────────────────
    const socStr   = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
    const batPwStr = battery.powerW !== null
      ? (battery.powerW >= 0 ? ` ↑${Math.round(battery.powerW)}W` : ` ↓${Math.round(Math.abs(battery.powerW))}W`)
      : '';
    const active = statuses.filter((s) => s.allocatedW > 0);
    if (!active.length) {
      const stTextWait = batOverflowMode
        ? `Überschuss vorhanden · wartend${socStr}${batPwStr}`
        : batReserveMode
          ? `Orange Budget · kein Überschuss${socStr}${batPwStr}`
          : `kein Überschuss${socStr}${batPwStr}`;
      const waitMode = (batOverflowMode || batReserveMode) ? MODES.BATTERY_PRIORITY : MODES.HOLDING;
      await this._setMode(waitMode, stTextWait);
      return alwaysW;
    } else {
      const parts  = active.map((s) => `${s.amps}A/${s.phases}ph`).join(' + ');
      const prefix = batOverflowMode ? 'Überschuss · ' : batReserveMode ? 'Reserve · ' : '';
      const stTextSolar = `${prefix}${parts}${active.length > 1 ? ` (${active.length} Lader)` : ''}${socStr}${batPwStr}`;
      await this._setMode(MODES.SOLAR_EV, stTextSolar);
      return alwaysW + active.reduce((s, r) => s + r.allocatedW, 0);
    }
  },

  async _stepCharger(charger, budgetW, configPhases, now, gridW, forcedDown) {
    const st  = this._getChargerState(charger.id);
    const cur = st.currentAmps ?? 0;

    // First tick after startup: observe only — no charger commands.
    // Prevents a spurious start/stop caused by stale phase state (currentPhases=null)
    // triggering an immediate phase-switch before the 30 s STEP_HOLD_MS guard kicks in.
    if (!this._warmupDone) return { amps: cur, phases: configPhases, allocatedW: cur * configPhases * 230 };

    // ── Phase determination ───────────────────────────────────────────────────
    let phases = configPhases;
    if (charger.phaseSwitch) {
      const targetPhases  = this._bestPhases(budgetW);
      const currentPhases = st.currentPhases ?? configPhases;

      if (targetPhases !== currentPhases) {
        if (cur > 0) {
          // Charger already running: attempt immediate phase switch (with cooldown).
          const canSwitch = !st.lastPhaseSwitchAt || (now - st.lastPhaseSwitchAt) >= PHASE_SWITCH_COOLDOWN_MS;
          if (canSwitch && !forcedDown) {
            const maxA      = targetPhases === 1 ? Math.min(charger.maxAmps, 16) : charger.maxAmps;
            const newLadder = AMPS_LADDER
              .filter((a) => a >= charger.minAmps && a <= maxA)
              .map((a) => ({ amps: a, watts: a * targetPhases * 230 }));
            const newTarget = [...newLadder].reverse().find((r) => r.watts <= budgetW) ?? newLadder[0];
            if (newTarget) {
              st.currentPhases     = targetPhases;
              st.lastPhaseSwitchAt = now;
              st.pendingStepAmps   = null;
              st.pendingStepSince  = null;
              await this._chargerSetAmps(charger.id, newTarget.amps, targetPhases);
              return { amps: newTarget.amps, phases: targetPhases, allocatedW: newTarget.amps * targetPhases * 230 };
            }
          }
          phases = currentPhases; // waiting for cooldown — keep current phases
        } else {
          // Charger stopped: use target phases for the amp ladder so the
          // pending-step mechanism starts at the correct phase count.
          // _chargerSetAmps will persist currentPhases when it fires.
          phases = targetPhases;
        }
      } else {
        phases = currentPhases;
      }
    }

    // ── Build amp ladder for effective phase count ────────────────────────────
    const maxA   = (charger.phaseSwitch && phases === 1) ? Math.min(charger.maxAmps, 16) : charger.maxAmps;
    const ladder = AMPS_LADDER
      .filter((a) => a >= charger.minAmps && a <= maxA)
      .map((a) => ({ amps: a, watts: a * phases * 230 }));
    // Find highest rung that fits the budget. If none fits (budget below the
    // smallest rung), target stays null → handled below (hold-at-min or stop).
    let target = null;
    for (const r of ladder) { if (r.watts <= budgetW) target = r; }

    if (!target) {
      if (cur > 0) {
        // Export guard: if we're still exporting, hold at minimum instead of stopping.
        // Prevents oscillation when budget dips just below the smallest rung due to
        // battery correction while solar surplus is visibly present.
        if (!forcedDown && gridW !== null && gridW <= -EXPORT_GUARD_W) {
          const minRung = ladder[0];
          if (minRung) {
            if (minRung.amps !== cur) await this._chargerSetAmps(charger.id, minRung.amps, phases);
            return { amps: minRung.amps, phases, allocatedW: minRung.amps * phases * 230 };
          }
        }
        await this._chargerStop(charger.id);
      }
      return { amps: 0, phases, allocatedW: 0 };
    }

    // Forced step-down (sustained import) — bypass anti-thrash
    if (forcedDown && target.amps < cur) {
      st.pendingStepAmps = null; st.pendingStepSince = null;
      st.lastDownStepAt  = now;
      await this._chargerSetAmps(charger.id, target.amps, phases);
      return { amps: target.amps, phases, allocatedW: target.amps * phases * 230 };
    }

    if (target.amps > cur) {
      // ── Step up ──────────────────────────────────────────────────────────
      const okCooldown = !st.lastDownStepAt || (now - st.lastDownStepAt) >= FLIP_COOLDOWN_MS;
      if (!okCooldown) return { amps: cur, phases, allocatedW: cur * phases * 230 };

      // Step-up destination. A running charger leaves UP_MARGIN_W of headroom above the
      // new rung so a brief surplus dip won't immediately flip to import. We pick the
      // HIGHEST rung whose watts + margin still fit the budget — checking
      // `budget >= target.watts + margin` directly was unsatisfiable whenever the rung
      // gap is smaller than the margin (single-phase rungs are 230 W apart, margin is
      // 250 W), which used to pin 1-phase chargers at their start amps forever.
      // A fresh start (cur === 0) has no margin requirement — it commits to `target`.
      let up = target;
      if (cur > 0) {
        up = [...ladder].reverse().find((r) => r.amps > cur && (r.watts + UP_MARGIN_W) <= budgetW) ?? null;
        if (!up) {
          st.pendingStepAmps = null; st.pendingStepSince = null;
          return { amps: cur, phases, allocatedW: cur * phases * 230 };
        }
      }

      if (st.pendingStepAmps !== up.amps) {
        st.pendingStepAmps = up.amps; st.pendingStepSince = now;
        return { amps: cur, phases, allocatedW: cur * phases * 230 };
      }

      const stepHoldMs = charger.stepHoldMs || STEP_HOLD_MS;
      if ((now - st.pendingStepSince) < stepHoldMs) {
        return { amps: cur, phases, allocatedW: cur * phases * 230 };
      }

      st.pendingStepAmps = null; st.pendingStepSince = null;
      await this._chargerSetAmps(charger.id, up.amps, phases);
      return { amps: up.amps, phases, allocatedW: up.amps * phases * 230 };

    } else if (target.amps < cur) {
      // ── Step down ────────────────────────────────────────────────────────
      if (gridW !== null && gridW <= -EXPORT_GUARD_W) {
        st.pendingStepAmps = null; st.pendingStepSince = null;
        return { amps: cur, phases, allocatedW: cur * phases * 230 };
      }
      st.pendingStepAmps = null; st.pendingStepSince = null;
      st.lastDownStepAt  = now;
      await this._chargerSetAmps(charger.id, target.amps, phases);
      return { amps: target.amps, phases, allocatedW: target.amps * phases * 230 };

    } else {
      // ── Steady ───────────────────────────────────────────────────────────
      st.pendingStepAmps = null; st.pendingStepSince = null;
      return { amps: target.amps, phases, allocatedW: target.amps * phases * 230 };
    }
  },

};
