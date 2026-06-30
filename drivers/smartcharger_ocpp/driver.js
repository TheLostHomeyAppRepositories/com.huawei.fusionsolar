'use strict';

const { Driver } = require('homey');

class SmartChargerOcppDriver extends Driver {

  async onInit() {
    this.log('SmartCharger OCPP driver initialised');
  }

  async onPair(session) {
    session.setHandler('add', async ({ stationId, name }) => {
      stationId = (stationId || '').trim();
      if (!stationId) throw new Error('Please enter a Station ID.');

      this.log(`Pairing OCPP SmartCharger with station ID: ${stationId}`);
      return { success: true };
    });
  }

}

module.exports = SmartChargerOcppDriver;
