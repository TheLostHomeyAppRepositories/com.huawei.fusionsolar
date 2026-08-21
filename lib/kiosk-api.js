'use strict';

const https = require('https');
const http = require('http');

/**
 * Parses a FusionSolar Kiosk URL and returns the base URL and kk token.
 *
 * Supports:
 *   https://uni001eu5.fusionsolar.huawei.com/pvmswebsite/.../cloud.html#/kiosk?kk=XXXXX
 *   https://eu5.fusionsolar.huawei.com/singleKiosk.html?kk=XXXXX
 *
 * @param {string} kioskUrl
 * @returns {{ baseUrl: string, kk: string }}
 */
function parseKioskUrl(kioskUrl) {
  if (!kioskUrl || typeof kioskUrl !== 'string') {
    throw new Error('Invalid kiosk URL');
  }

  const url = kioskUrl.trim();

  const kkMatch = url.match(/[?&#]kk=([^&\s]+)/);
  if (!kkMatch) {
    throw new Error('Could not find kk parameter in kiosk URL');
  }

  const urlMatch = url.match(/^(https?:\/\/[^/]+)/);
  if (!urlMatch) {
    throw new Error('Could not parse base URL from kiosk URL');
  }

  return {
    baseUrl: urlMatch[1],
    kk: kkMatch[1],
  };
}

/**
 * Builds the REST API endpoint URL for fetching kiosk data.
 *
 * @param {string} baseUrl
 * @param {string} kk
 * @returns {string}
 */
function buildApiUrl(baseUrl, kk) {
  return `${baseUrl}/rest/pvms/web/kiosk/v1/station-kiosk-file?kk=${kk}`;
}

/**
 * Fetches JSON data from the FusionSolar Kiosk REST API.
 *
 * @param {string} apiUrl
 * @returns {Promise<Object>}
 */
function fetchKioskData(apiUrl) {
  return new Promise((resolve, reject) => {
    const transport = apiUrl.startsWith('https') ? https : http;

    const req = transport.get(
      apiUrl,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Homey/FusionSolarKiosk',
        },
        timeout: 15000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          try {
            // The FusionSolar Kiosk API embeds a JSON string inside the outer JSON,
            // with double-encoded HTML entities. The pattern is:
            //   {"success":true,"data":"{&quot;realKpi&quot;:{...}}"}
            //
            // Strategy:
            //   1. Replace &quot; with \" so the outer JSON stays valid.
            //   2. Parse the outer JSON.
            //   3. If data is a string, parse it as inner JSON.
            //
            // NOTE: replacing &quot; → " (unescaped) on the whole string would
            // break the outer JSON structure – that was the previous bug.
            const clean = raw
              .replace(/&quot;/g, '\\"')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>');

            const outer = JSON.parse(clean);

            if (outer.success === false) {
              reject(new Error(`API error: ${outer.failCode || 'unknown'}`));
              return;
            }

            // Flatten nested data field
            let merged = { ...outer };
            if (typeof outer.data === 'string') {
              // Failing this parse used to be swallowed, keeping the outer envelope — which
              // carries no realKpi, so extractKpiValues then read an empty object and every
              // figure came out as a confident zero. Two silent fallbacks in a row turned a
              // broken response into "the array is producing 0 W". The unpacking above is
              // string surgery on HTML entities and can genuinely fail on a payload it does
              // not anticipate, so this is not a theoretical branch: it has to be loud.
              try {
                const inner = JSON.parse(outer.data);
                merged = { ...outer, ...inner };
              } catch (err) {
                reject(new Error(`Failed to parse response data: ${err.message}`));
                return;
              }
            } else if (outer.data && typeof outer.data === 'object') {
              merged = { ...outer, ...outer.data };
            }

            resolve(merged);
          } catch (err) {
            reject(new Error(`Failed to parse response: ${err.message}`));
          }
        });
      },
    );

    req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

/**
 * Extracts normalised KPI values from raw kiosk data.
 *
 * A missing figure comes back as null, never as 0. The difference matters more here than
 * anywhere else in the app: `num()` used to fold every absent or unparseable value into 0,
 * and the KPI block itself fell back to `{}`, so a response that carried no measurements at
 * all produced a complete, confident set of zeros. Nothing threw, the device stayed
 * available, and the tile read "0 W" — indistinguishable from a roof in the dark.
 *
 * Worst of it was cumulativeEnergy: Homey derives the daily yield from that counter by
 * difference, so writing 0 and then the true reading again books the entire lifetime output
 * as one day's production.
 *
 * Reported from the field on 2026-08-21 (log 9c7e4414): "I have to restart the app all the
 * time to get the solar production shown" — a restart fetches once from onInit, which
 * happened to land on a good response.
 *
 * No KPI block at all is a broken response rather than a missing figure, and throws: the
 * caller marks the device unavailable, which is the honest thing to show.
 *
 * @param {Object} data
 * @returns {{
 *   realTimePower: number|null,    // W  – current generation power
 *   dailyEnergy: number|null,      // kWh
 *   monthEnergy: number|null,      // kWh
 *   yearEnergy: number|null,       // kWh
 *   cumulativeEnergy: number|null  // kWh
 * }}
 */
function extractKpiValues(data) {
  const kpi = (data && (data.realKpi || data.stationOverview)) || null;
  if (!kpi || typeof kpi !== 'object') {
    throw new Error('Response contained no KPI data');
  }

  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  // realTimePower is reported in kW – convert to W for Homey's measure_power capability
  const realTimePowerKw = num(kpi.realTimePower ?? kpi.activePower);

  return {
    realTimePower: realTimePowerKw === null ? null : Math.round(realTimePowerKw * 1000),
    dailyEnergy: num(kpi.dailyEnergy ?? kpi.dayPower),
    monthEnergy: num(kpi.monthEnergy ?? kpi.monthPower),
    yearEnergy: num(kpi.yearEnergy ?? kpi.yearPower),
    cumulativeEnergy: num(kpi.cumulativeEnergy ?? kpi.totalPower),
  };
}

module.exports = { parseKioskUrl, buildApiUrl, fetchKioskData, extractKpiValues };
