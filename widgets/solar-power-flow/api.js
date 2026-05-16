'use strict';

const { getPowerData } = require('../../lib/widget-data');

module.exports = {
  async getData({ homey }) {
    return getPowerData(homey);
  },
};
