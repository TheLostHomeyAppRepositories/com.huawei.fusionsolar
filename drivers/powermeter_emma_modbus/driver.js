'use strict';

const { Driver } = require('homey');
const {
  POWERMETER_EMMA_DATA_REGISTERS,
  isPowerMeterEmmaDataValid,
} = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');
const { pauseDevicesOnHost, resumePairedDevices, parseIntSafe } = require('../../lib/pairing-helper');

class PowerMeterEmmaModbusDriver extends Driver {

  async onInit() {
    this.log('Power Meter EMMA Modbus driver initialised');
  }

  async onPair(session) {
    session.setHandler('connect', async ({ address, port, modbusId, name }) => {
      address  = (address || '').trim();
      port     = parseIntSafe(port, 502);
      modbusId = parseIntSafe(modbusId, 0); // EMMA default unit ID is 0

      if (!address) {
        throw new Error(this.homey.__('modbus.pair.errors.noAddress'));
      }

      // Pause all Modbus devices on this host so the pairing probe gets exclusive TCP access.
      const paused = await pauseDevicesOnHost(this.homey, address);
      let data;
      try {
        data = await readModbusRegisters(address, port, modbusId, POWERMETER_EMMA_DATA_REGISTERS);
      } finally {
        await resumePairedDevices(paused);
      }

      if (!isPowerMeterEmmaDataValid(data)) {
        throw new Error(this.homey.__('modbus.pair.errors.meterNotDetected'));
      }

      this.log(`Pairing Power Meter (EMMA) at ${address}:${port} id=${modbusId}, feedIn=${data.feedInPower}W`);

      return {
        success: true,
        kpi: {
          feedInPower:         data.feedInPower,
          totalFeedInToGrid:   data.totalFeedInToGrid,
          totalSupplyFromGrid: data.totalSupplyFromGrid,
        },
      };
    });
  }

}

module.exports = PowerMeterEmmaModbusDriver;
