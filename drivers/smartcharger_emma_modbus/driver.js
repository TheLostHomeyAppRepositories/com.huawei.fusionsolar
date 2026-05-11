'use strict';

const { Driver } = require('homey');
const { SMARTCHARGER_REGISTERS } = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');
const { pauseDevicesOnHost, resumePairedDevices, parseIntSafe } = require('../../lib/pairing-helper');

class SmartChargerModbusDriver extends Driver {

  async onInit() {
    this.log('SmartCharger Modbus driver initialised');
  }

  async onPair(session) {
    session.setHandler('connect', async ({ address, port, modbusId, name }) => {
      address  = (address || '').trim();
      port     = parseIntSafe(port, 502);
      modbusId = parseIntSafe(modbusId, 1); // 0 is a valid unit ID — avoid || 1

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
