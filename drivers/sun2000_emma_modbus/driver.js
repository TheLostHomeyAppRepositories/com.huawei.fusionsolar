'use strict';

const { Driver } = require('homey');
const {
  SUN2000_EMMA_DATA_REGISTERS,
  isSun2000EmmaDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');
const { pauseDevicesOnHost, resumePairedDevices, parseIntSafe } = require('../../lib/pairing-helper');

class SUN2000EmmaModbusDriver extends Driver {

  async onInit() {
    this.log('SUN2000 EMMA Modbus driver initialised');
  }

  async onPair(session) {
    session.setHandler('connect', async ({ address, port, modbusId, name }) => {
      address  = (address || '').trim();
      port     = parseIntSafe(port, 502);
      modbusId = parseIntSafe(modbusId, 0); // EMMA default unit ID is 0

      if (!address) {
        throw new Error(this.homey.__('modbus.pair.errors.noAddress'));
      }

      const probeRegisters = {
        pvOutputPower:       SUN2000_EMMA_DATA_REGISTERS.pvOutputPower,
        inverterActivePower: SUN2000_EMMA_DATA_REGISTERS.inverterActivePower,
        inverterTotalYield:  SUN2000_EMMA_DATA_REGISTERS.inverterTotalYield,
        inverterYieldToday:  SUN2000_EMMA_DATA_REGISTERS.inverterYieldToday,
      };

      // Pause all Modbus devices on this host so the pairing probe gets exclusive TCP access.
      const paused = await pauseDevicesOnHost(this.homey, address);
      let data;
      try {
        data = await readModbusRegisters(address, port, modbusId, probeRegisters);
      } finally {
        await resumePairedDevices(paused);
      }

      if (!isSun2000EmmaDataValid(data)) {
        throw new Error(this.homey.__('modbus.pair.errors.inverterNotDetected'));
      }

      this.log(`Pairing SUN2000 (EMMA) at ${address}:${port} id=${modbusId}, PV=${data.pvOutputPower}W`);

      return {
        success: true,
        kpi: {
          pvOutputPower:      data.pvOutputPower,
          inverterActivePower: data.inverterActivePower,
          inverterTotalYield: data.inverterTotalYield,
          inverterYieldToday: data.inverterYieldToday,
        },
      };
    });
  }

}

module.exports = SUN2000EmmaModbusDriver;
