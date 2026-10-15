'use strict';

const { Driver } = require('homey');

class EaseeOcppDriver extends Driver {

  async onInit() {
    this.log('Easee OCPP driver initialised');
  }

  async onPair(session) {
    session.setHandler('add', async ({ stationId, name }) => {
      stationId = (stationId || '').trim();
      this.log(`Pairing Easee (OCPP): station ID = "${stationId || '(catch-all)'}"`);
      return { success: true };
    });
  }

}

module.exports = EaseeOcppDriver;
