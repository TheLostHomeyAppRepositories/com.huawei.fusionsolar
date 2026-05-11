'use strict';

const { Driver } = require('homey');
const { POWER_METER_REGISTERS, isPowerMeterDataValid } = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');
const { pauseDevicesOnHost, resumePairedDevices, parseIntSafe } = require('../../lib/pairing-helper');

class DTSU666ModbusDriver extends Driver {

  async onInit() {
    this.log('DTSU666 Modbus driver initialised');
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
        powerMeterActivePower: POWER_METER_REGISTERS.powerMeterActivePower,
        gridExportedEnergy:    POWER_METER_REGISTERS.gridExportedEnergy,
        gridAccumulatedEnergy: POWER_METER_REGISTERS.gridAccumulatedEnergy,
      };

      // Pause all Modbus devices on this host so the pairing probe gets exclusive TCP access.
      const paused = await pauseDevicesOnHost(this.homey, address);
      let data;
      try {
        data = await readModbusRegisters(address, port, modbusId, probeRegisters);
      } finally {
        await resumePairedDevices(paused);
      }

      if (!isPowerMeterDataValid(data)) {
        throw new Error(this.homey.__('modbus.pair.errors.meterNotDetected'));
      }

      this.log(`Pairing DTSU666 at ${address}:${port} id=${modbusId}, activePower=${data.powerMeterActivePower}W`);

      return {
        success: true,
        kpi: {
          powerMeterActivePower: data.powerMeterActivePower,
          gridExportedEnergy:    data.gridExportedEnergy,
          gridAccumulatedEnergy: data.gridAccumulatedEnergy,
        },
      };
    });
  }

}

module.exports = DTSU666ModbusDriver;
