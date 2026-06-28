'use strict';

const { Driver } = require('homey');
const { login, getStationList } = require('../../lib/openapi-client');

class ISitePowerBatteryDriver extends Driver {

  async onInit() {
    this.log('iSitePower-M Battery OpenAPI driver initialised');
  }

  async onPair(session) {
    let _token   = null;
    let _baseUrl = 'https://intl.fusionsolar.huawei.com';

    session.setHandler('login', async ({ baseUrl, username, systemCode }) => {
      _baseUrl = (baseUrl || 'https://intl.fusionsolar.huawei.com').trim().replace(/\/$/, '');
      _token   = await login(_baseUrl, username, systemCode);

      const { stations } = await getStationList(_baseUrl, _token);
      if (!stations.length) throw new Error(this.homey.__('openapi.pair.errors.noStations'));

      this.log(`Login OK – ${stations.length} station(s) found`);
      return { success: true, stations };
    });
  }

}

module.exports = ISitePowerBatteryDriver;
