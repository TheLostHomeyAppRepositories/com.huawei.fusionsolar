'use strict';

const { Driver } = require('homey');
const { BATTERY_REGISTERS, isBatteryDataValid } = require('../../lib/modbus-registers');
const { readModbusRegisters } = require('../../lib/modbus-client');
const { pauseDevicesOnHost, resumePairedDevices, parseIntSafe } = require('../../lib/pairing-helper');

class LUNA2000ModbusDriver extends Driver {

  async onInit() {
    this.log('LUNA2000 Modbus driver initialised');
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
        storageSOC:               BATTERY_REGISTERS.storageSOC,
        storageChargeDischarge:   BATTERY_REGISTERS.storageChargeDischarge,
        storageMaxChargePower:    BATTERY_REGISTERS.storageMaxChargePower,
        storageMaxDischargePower: BATTERY_REGISTERS.storageMaxDischargePower,
        storageDayCharge:         BATTERY_REGISTERS.storageDayCharge,
        storageDayDischarge:      BATTERY_REGISTERS.storageDayDischarge,
      };

      // Pause all Modbus devices on this host so the pairing probe gets exclusive TCP access.
      const paused = await pauseDevicesOnHost(this.homey, address);
      let data;
      try {
        data = await readModbusRegisters(address, port, modbusId, probeRegisters);
      } finally {
        await resumePairedDevices(paused);
      }

      if (!isBatteryDataValid(data)) {
        throw new Error(this.homey.__('modbus.pair.errors.batteryNotDetected'));
      }

      this.log(`Pairing LUNA2000 at ${address}:${port} id=${modbusId}, SOC=${data.storageSOC}%`);

      return {
        success: true,
        kpi: {
          storageSOC:               data.storageSOC,
          storageChargeDischarge:   data.storageChargeDischarge,
          storageMaxChargePower:    data.storageMaxChargePower,
          storageMaxDischargePower: data.storageMaxDischargePower,
        },
      };
    });
  }

}

module.exports = LUNA2000ModbusDriver;
