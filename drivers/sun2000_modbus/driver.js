'use strict';

const { Driver } = require('homey');
const { REGISTERS } = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');
const { pauseDevicesOnHost, resumePairedDevices, parseIntSafe } = require('../../lib/pairing-helper');

class SUN2000ModbusDriver extends Driver {

  async onInit() {
    this.log('SUN2000 Modbus driver initialised');
  }

  async onPair(session) {
    session.setHandler('connect', async ({ address, port, modbusId, name }) => {
      address  = (address || '').trim();
      port     = parseIntSafe(port, 502);
      modbusId = parseIntSafe(modbusId, 1); // 0 is a valid unit ID — avoid || 1

      if (!address) {
        throw new Error(this.homey.__('modbus.pair.errors.noAddress'));
      }

      // Read identification + basic power registers to validate connection
      const probeRegisters = {
        modelName:              REGISTERS.modelName,
        activePower:            REGISTERS.activePower,
        dailyYieldEnergy:       REGISTERS.dailyYieldEnergy,
        accumulatedYieldEnergy: REGISTERS.accumulatedYieldEnergy,
        internalTemperature:    REGISTERS.internalTemperature,
        deviceStatus:           REGISTERS.deviceStatus,
      };

      // Pause all Modbus devices on this host so the pairing probe gets exclusive TCP access.
      const paused = await pauseDevicesOnHost(this.homey, address);
      let data;
      try {
        data = await readModbusRegisters(address, port, modbusId, probeRegisters);
      } finally {
        await resumePairedDevices(paused);
      }

      this.log(`Pairing SUN2000 at ${address}:${port} id=${modbusId}, model="${data.modelName}", power=${data.activePower}W`);

      return {
        success: true,
        modelName: data.modelName || 'SUN2000',
        kpi: {
          activePower:            data.activePower,
          dailyYieldEnergy:       data.dailyYieldEnergy,
          accumulatedYieldEnergy: data.accumulatedYieldEnergy,
          internalTemperature:    data.internalTemperature,
        },
      };
    });
  }

}

module.exports = SUN2000ModbusDriver;
