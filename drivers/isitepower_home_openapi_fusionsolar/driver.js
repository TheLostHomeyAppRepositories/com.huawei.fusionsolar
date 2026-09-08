'use strict';

const { Driver } = require('homey');
const { login, getStationList } = require('../../lib/openapi-client');
const { openapiCredentials } = require('../../lib/openapi-credentials');

class ISitePowerHomeDriver extends Driver {

  async onInit() {
    this.log('iSitePower-M Home OpenAPI driver initialised');
  }

  async onPair(session) {
    let _token   = null;
    let _baseUrl = 'https://intl.fusionsolar.huawei.com';

    // One account serves every OpenAPI device, so the dialog opens with whatever the app
    // already knows rather than asking for the system code a seventh time. Read only —
    // see lib/openapi-credentials.js for where it comes from and what is not written.
    session.setHandler('credentials', async () => openapiCredentials(this.homey));

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

module.exports = ISitePowerHomeDriver;
