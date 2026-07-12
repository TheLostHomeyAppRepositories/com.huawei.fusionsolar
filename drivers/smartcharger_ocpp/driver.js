'use strict';

const { Driver } = require('homey');

class SmartChargerOcppDriver extends Driver {

  async onInit() {
    this.log('SmartCharger OCPP driver initialised');
  }

  async onPair(session) {
    session.setHandler('add', async ({ stationId, name }) => {
      stationId = (stationId || '').trim();
      this.log(`Pairing OCPP SmartCharger: station ID = "${stationId || '(catch-all)'}"`);
      return { success: true };
    });
  }

}

module.exports = SmartChargerOcppDriver;
