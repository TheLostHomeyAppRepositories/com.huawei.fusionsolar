'use strict';

function getDevice(homey, driverId) {
  try {
    const driver = homey.drivers.getDriver(driverId);
    const devices = driver.getDevices();
    return devices.length > 0 ? devices[0] : null;
  } catch { return null; }
}

function cap(device, id, fallback = null) {
  if (!device) return fallback;
  try { return device.getCapabilityValue(id) ?? fallback; } catch { return fallback; }
}

// Rolling buffer — persisted in homey.settings so it survives app restarts
const _buf       = [];
const SAMPLE_MS  = 2 * 60 * 1000;    // one point every 2 minutes
const MAX_AGE_MS = 12 * 3600 * 1000; // keep 12 hours
let   _lastSample = 0;
let   _loaded     = false;            // restore from settings only once per process

module.exports = {
  async getData({ homey }) {
    const sdongle    = getDevice(homey, 'sdongle_a_modbus');
    const sun2000    = getDevice(homey, 'sun2000_modbus');
    const sun2000em  = getDevice(homey, 'sun2000_emma_modbus');
    const luna2000   = getDevice(homey, 'luna2000_modbus');
    const luna2000em = getDevice(homey, 'luna2000_emma_modbus');
    const pmEmma     = getDevice(homey, 'powermeter_emma_modbus');

    let pvPower, gridPower, battPower, housePower;
    if (sdongle) {
      pvPower    = cap(sdongle, 'measure_power.solar',             0);
      gridPower  = cap(sdongle, 'measure_power.grid_active_power', 0);
      battPower  = cap(sdongle, 'measure_power.battery',           0);
      housePower = cap(sdongle, 'measure_power',                   0);
    } else {
      pvPower    = cap(sun2000,   'measure_power',                   null) ?? cap(sun2000em,  'measure_power', 0);
      gridPower  = cap(sun2000,   'measure_power.grid_active_power', null) ?? cap(pmEmma,     'measure_power', 0);
      battPower  = cap(luna2000,  'measure_power',                   null) ?? cap(luna2000em, 'measure_power', 0);
      housePower = Math.max(0, pvPower + gridPower - battPower);
    }

    const now    = Date.now();
    const fromMs = now - MAX_AGE_MS;

    // On first call after app restart: restore buffer from settings
    if (!_loaded) {
      _loaded = true;
      try {
        const saved = homey.settings.get('power_chart_history');
        if (Array.isArray(saved)) {
          const valid = saved.filter(p => p.t >= fromMs);
          _buf.push(...valid);
          if (valid.length > 0) _lastSample = valid[valid.length - 1].t;
        }
      } catch (e) {}
    }

    // Add sample if interval elapsed, then persist to settings
    if (now - _lastSample >= SAMPLE_MS) {
      _buf.push({ t: now, pv: pvPower, grid: gridPower, batt: battPower, house: housePower });
      _lastSample = now;
      while (_buf.length > 0 && _buf[0].t < fromMs) _buf.shift();
      try { homey.settings.set('power_chart_history', _buf); } catch (e) {}
    }

    // Build per-series arrays [{t, v}] for the chart
    const pvSeries    = _buf.map(p => ({ t: p.t, v: p.pv    })).filter(p => p.v != null);
    const gridSeries  = _buf.map(p => ({ t: p.t, v: p.grid  })).filter(p => p.v != null);
    const battSeries  = _buf.map(p => ({ t: p.t, v: p.batt  })).filter(p => p.v != null);
    const houseSeries = _buf.map(p => ({ t: p.t, v: p.house })).filter(p => p.v != null);

    // Peak PV today
    const midnight  = new Date(); midnight.setHours(0, 0, 0, 0);
    const todayPv   = pvSeries.filter(p => p.t >= midnight.getTime());
    const peakToday = todayPv.length > 0 ? Math.max(...todayPv.map(p => p.v)) : null;

    return {
      series:   { pv: pvSeries, grid: gridSeries, batt: battSeries, house: houseSeries },
      pvNow:    pvPower,
      gridNow:  gridPower,
      battNow:  battPower,
      houseNow: housePower,
      peakToday,
    };
  },
};
