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

  async _evaluateEvChargers(battery, gridW, chargers, cfg, pvW = null, houseW = null) {
    if (!chargers.length) return 0;
    if (cfg.charger_control === false) return 0;
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
      for (const c of chargers) {
        if (!c.connected) continue;
        const st = this._getChargerState(c.id);
        if (this._warmupDone && (st.currentAmps !== c.maxAmps || st.currentPhases !== c.phases)) {
          await this._chargerSetAmps(c.id, c.maxAmps, c.phases);
        }
      }
      const parts = chargers.filter((c) => c.connected).map((c) => `${c.maxAmps}A/${c.phases}ph`).join(' + ');
      const stTextInstant = parts;
      await this._setMode(MODES.INSTANT_EV, stTextInstant);
      return chargers.filter((c) => c.connected).reduce((s, c) => s + c.maxAmps * c.phases * 230, 0);
    }

    // ── P0.5: "Always charge" mode ───────────────────────────────────────────
    // Charges at max power as soon as the cable is in — independent of solar and
    // battery state (same standing as instant charging). These chargers are then
    // removed from the solar/off-peak logic below.
    let alwaysW = 0;
    const alwaysChargers = chargers.filter((c) => c.chargeMode === 'always');
    if (alwaysChargers.length) {
      for (const c of alwaysChargers) {
        const st = this._getChargerState(c.id);
        if (!c.connected) {
          if (st.currentAmps !== null) await this._chargerStop(c.id);
          continue;
        }
        if (this._warmupDone && (st.currentAmps !== c.maxAmps || st.currentPhases !== c.phases)) {
          await this._chargerSetAmps(c.id, c.maxAmps, c.phases);
        }
        alwaysW += c.maxAmps * c.phases * 230;
      }
      chargers = chargers.filter((c) => c.chargeMode !== 'always');
      if (!chargers.length) {
        const connAlways = alwaysChargers.filter((c) => c.connected);
        if (!connAlways.length) {
          const aSocStr = battery.soc !== null ? ` · Bat ${Math.round(battery.soc)}%` : '';
          await this._setMode(MODES.IDLE, `kein EV verbunden${aSocStr}`);
          return 0;
        }
        const aParts = connAlways.map((c) => `${c.maxAmps}A/${c.phases}ph`).join(' + ');
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
    // Off-peak applies to chargers in "Solar & tariff-optimised" mode. The global
    // offpeak_enabled tile toggle still works as a legacy/global enable.
    const offpeakChargers = chargers.filter((c) => c.connected
      && (c.chargeMode === 'solar_offpeak' || this.getCapabilityValue('offpeak_enabled') === true));
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
        for (const c of offpeakChargers) {
          const opPhases = c.phaseSwitch ? 3 : c.phases;
          const st       = this._getChargerState(c.id);
          if (this._warmupDone && (st.currentAmps !== opAmps || st.currentPhases !== opPhases)) {
            await this._chargerSetAmps(c.id, opAmps, opPhases);
            if (c.phaseSwitch) st.lastPhaseSwitchAt = now;
          }
        }
        const n = offpeakChargers.length;
        const stTextOffpeak = `${opAmps}A × ${n} Lader`;
        await this._setMode(MODES.OFFPEAK_EV, stTextOffpeak);
        return alwaysW + offpeakChargers.reduce((s, c) => s + opAmps * (c.phaseSwitch ? 3 : c.phases) * 230, 0);
      }
      // else: solar has surplus — fall through to solar surplus logic below
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
