'use strict';

const { Driver } = require('homey');
const { SMARTCHARGER_REGISTERS } = require('../../lib/modbus-registers');
const { readModbusRegisters, refused } = require('../../lib/modbus-client');
const { pauseDevicesOnHost, resumePairedDevices, parseIntSafe } = require('../../lib/pairing-helper');

class SmartChargerModbusDriver extends Driver {

  async onInit() {
    this.log('SmartCharger Modbus driver initialised');
  }

  async onPair(session) {
    session.setHandler('connect', async ({ address, port, modbusId, name }) => {
      address  = (address || '').trim();
      port     = parseIntSafe(port, 502);
      modbusId = parseIntSafe(modbusId, 0); // 0 is a valid unit ID — avoid || 0

      if (!address) {
        throw new Error(this.homey.__('modbus.pair.errors.noAddress'));
      }

      const probeRegisters = {
        offeringName:       SMARTCHARGER_REGISTERS.offeringName,
        ratedPower:         SMARTCHARGER_REGISTERS.ratedPower,
        totalEnergyCharged: SMARTCHARGER_REGISTERS.totalEnergyCharged,
        chargerTemperature: SMARTCHARGER_REGISTERS.chargerTemperature,
        phaseAVoltage:      SMARTCHARGER_REGISTERS.phaseAVoltage,
      };

      // Pause all Modbus devices on this host so the pairing probe gets exclusive TCP access.
      const paused = await pauseDevicesOnHost(this.homey, address);
      let data;
      try {
        data = await readModbusRegisters(address, port, modbusId, probeRegisters);
      } finally {
        await resumePairedDevices(paused);
      }

      // The rated power refused: this unit is not the charger — the same test the device makes
      // on every poll (device.js). With a name it is the EMMA itself, whose own unit holds the
      // EMMA's name at 30000; without one nothing answers as a charger at all (unit 1 in log
      // f3b5238a refused even the name, with exception 4). Pairing used to take both, and the
      // device then said "idle" with nothing behind it, or "charging" with the EMMA's meter
      // voltages (log 2aafa4d3), or "not detected" from its third poll on.
      if (refused(data, 'ratedPower')) {
        this.log(`Pairing refused at ${address}:${port} id=${modbusId}: `
          + (data.offeringName ? `answers as "${data.offeringName}", ` : '') + 'refuses the rated power (30076)');
        throw new Error(data.offeringName
          ? this.homey.__('modbus.errors.chargerIsEmma', { id: modbusId, name: data.offeringName })
          : this.homey.__('modbus.errors.chargerNotDetected'));
      }

      this.log(`Pairing SmartCharger at ${address}:${port} id=${modbusId}, name="${data.offeringName}", rated=${data.ratedPower}kW`);

      return {
        success:      true,
        offeringName: data.offeringName || 'SmartCharger',
        kpi: {
          ratedPower:         data.ratedPower,
          totalEnergyCharged: data.totalEnergyCharged,
          chargerTemperature: data.chargerTemperature,
          phaseAVoltage:      data.phaseAVoltage,
        },
      };
    });
  }

}

module.exports = SmartChargerModbusDriver;
