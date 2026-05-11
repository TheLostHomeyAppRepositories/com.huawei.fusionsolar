'use strict';

const { Driver } = require('homey');
const { SDONGLE_A_REGISTERS, isSdonglaADataValid } = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');
const { pauseDevicesOnHost, resumePairedDevices, parseIntSafe } = require('../../lib/pairing-helper');

class SdonglaAModbusDriver extends Driver {

  async onInit() {
    this.log('SDongle A Modbus driver initialised');
  }

  async onPair(session) {
    session.setHandler('connect', async ({ address, port, modbusId, name }) => {
      address  = (address || '').trim();
      port     = parseIntSafe(port, 502);
      modbusId = parseIntSafe(modbusId, 100); // SDongle default is 100 — 0 is still valid

      if (!address) {
        throw new Error(this.homey.__('modbus.pair.errors.noAddress'));
      }

      const probeRegisters = {
        totalInputPower: SDONGLE_A_REGISTERS.totalInputPower,
        gridPower:       SDONGLE_A_REGISTERS.gridPower,
        loadPower:       SDONGLE_A_REGISTERS.loadPower,
      };

      // Pause all Modbus devices on this host so the pairing probe gets exclusive TCP access.
      const paused = await pauseDevicesOnHost(this.homey, address);
      let data;
      try {
        data = await readModbusRegisters(address, port, modbusId, probeRegisters);
      } finally {
        await resumePairedDevices(paused);
      }

      if (!isSdonglaADataValid(data)) {
        throw new Error(this.homey.__('modbus.pair.errors.sdongleANotDetected'));
      }

      this.log(`Pairing SDongle A at ${address}:${port} id=${modbusId}, gridPower=${data.gridPower}W, solar=${data.totalInputPower}W`);

      return {
        success: true,
        kpi: {
          totalInputPower: data.totalInputPower,
          gridPower:       data.gridPower,
          loadPower:       data.loadPower,
        },
      };
    });
  }

}

module.exports = SdonglaAModbusDriver;
