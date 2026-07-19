'use strict';

const net = require('net');
const os  = require('os');

const {
  login:               openapiLogin,
  getStationList:      openapiGetStationList,
  getStationRealKpiRaw: openapiGetStationRealKpiRaw,
  getDevList:          openapiGetDevList,
  getDevRealKpi:       openapiGetDevRealKpi,
} = require('./lib/openapi-client');

const {
  REGISTERS,
  POWER_METER_REGISTERS,
  BATTERY_REGISTERS,
  BATTERY_MODULE_REGISTERS,
  CONTROL_REGISTERS,
  EMMA_REGISTERS,
  POWERMETER_EMMA_DATA_REGISTERS,
  SUN2000_EMMA_DATA_REGISTERS,
  LUNA2000_EMMA_DATA_REGISTERS,
  LUNA2000_EMMA_CONTROL_REGISTERS,
  SMARTCHARGER_REGISTERS,
  SDONGLE_A_REGISTERS,
} = require('./lib/modbus-registers');
const { readModbusRegisters, probeModbusUnit } = require('./lib/modbus-client');
const { version: APP_VERSION } = require('./app.json');

// ─── Register sets per driver ─────────────────────────────────────────────────
// Each entry maps a human-readable group name → register map.
// Used by the debug settings page to do live register reads.

const DRIVER_REGISTER_SETS = {
  sun2000_modbus: {
    'Inverter Data':       REGISTERS,
    'Power Meter Data':    POWER_METER_REGISTERS,
    'Control Registers':   CONTROL_REGISTERS,
  },
  luna2000_modbus: {
    'Battery Data':        BATTERY_REGISTERS,
    'Battery Modules':     BATTERY_MODULE_REGISTERS,
    'Control Registers':   CONTROL_REGISTERS,
  },
  dtsu666_modbus: {
    'Power Meter Data':    POWER_METER_REGISTERS,
  },
  sdongle_a_modbus: {
    'SDongle Registers':   SDONGLE_A_REGISTERS,
  },
  sun2000_emma_modbus: {
    'EMMA Inverter Data':  SUN2000_EMMA_DATA_REGISTERS,
  },
  luna2000_emma_modbus: {
    'EMMA Battery Data':   LUNA2000_EMMA_DATA_REGISTERS,
    'EMMA Control':        LUNA2000_EMMA_CONTROL_REGISTERS,
  },
  powermeter_emma_modbus: {
    'EMMA Meter Data':     POWERMETER_EMMA_DATA_REGISTERS,
  },
  smartcharger_emma_modbus: {
    'Smart Charger Data':  SMARTCHARGER_REGISTERS,
  },
};

const MODBUS_DRIVER_IDS = Object.keys(DRIVER_REGISTER_SETS);

// ─── API handlers ─────────────────────────────────────────────────────────────

async function _getEmsSimpleDeviceFlows({ homey, startCardId, stopCardId, startTokenName }) {
  let apiKey = '', emsDeviceId = '';
  try {
    const driver = homey.drivers.getDriver('energy_management');
    const devs   = driver.getDevices();
    if (devs.length > 0) { apiKey = devs[0].getSetting('homey_api_key') || ''; emsDeviceId = devs[0].getData().id || ''; }
  } catch { }
  if (!apiKey) return { matched: [], error: 'No API key' };
  const HomeyLocalApi = require('./lib/homey-local-api');
  const api = new HomeyLocalApi({ homey, apiKey });
  try {
    const flows = await api.getFlows().catch(() => ({}));
    const matched = [];
    for (const [id, f] of Object.entries(flows || {})) {
      const tid = f.trigger && f.trigger.id || '';
      const APP = 'homey:app:com.huawei.fusionsolar';
      if (tid === startCardId || tid === stopCardId || tid === `${APP}:${startCardId}` || tid === `${APP}:${stopCardId}`) {
        const firstAction = (f.actions || [])[0];
        let cardId = null, cardUri = null;
        if (firstAction) {
          const rawId = firstAction.id || '';
          if (rawId.startsWith('homey:')) { const lc = rawId.lastIndexOf(':'); cardId = rawId.slice(lc + 1); cardUri = rawId.slice(0, lc); }
          else { cardId = rawId; cardUri = firstAction.uri || ''; }
        }
        matched.push({ id, name: f.name || id, type: 'flow',
          triggerType: (tid === startCardId || tid === `${APP}:${startCardId}`) ? 'start' : 'stop',
          triggerDeviceId: (f.trigger && f.trigger.args && f.trigger.args[startTokenName]) || '',
          actionCardId: cardId, actionCardUri: cardUri });
      }
    }
    return { emsDeviceId, matched: matched.sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (e) { return { matched: [], error: e.message }; }
}

async function _postEmsSimpleDeviceSetupFlows({ homey, body, startCardId, stopCardId, tokenName, labelSuffix }) {
  const { emsDeviceId, deviceId, deviceName, startCardId: startActId, startCardUri, stopCardId: stopActId, stopCardUri } = body || {};
  if (!emsDeviceId || !deviceId || !startActId || !startCardUri || !stopActId || !stopCardUri)
    return { error: 'Missing required fields' };
  let apiKey = '';
  try {
    const driver = homey.drivers.getDriver('energy_management');
    const devs   = driver.getDevices();
    if (devs.length > 0) apiKey = devs[0].getSetting('homey_api_key') || '';
  } catch { }
  if (!apiKey) return { error: 'No API key' };
  const HomeyLocalApi = require('./lib/homey-local-api');
  const APP_URI = 'homey:app:com.huawei.fusionsolar';
  const api = new HomeyLocalApi({ homey, apiKey });
  let folderId = null;
  try {
    const folders  = await api.getFlowFolders();
    const existing = Object.values(folders || {}).find((f) => f.name === '_Huawei EMS');
    folderId = existing ? existing.id : (await api.createFlowFolder({ name: '_Huawei EMS' }))?.id || null;
  } catch (_) { }
  const baseName  = `EMS: ${deviceName || deviceId}`;
  const startName = `${baseName} → ${labelSuffix} Start`;
  const stopName  = `${baseName} → ${labelSuffix} Stop`;
  const allFlows  = await api.getFlows().catch(() => ({}));
  await Promise.all(Object.values(allFlows || {}).filter((f) => f.name === startName || f.name === stopName).map((f) => api.deleteFlow(f.id).catch(() => {})));
  const makeAction = (cId, cUri) => ({ id: cId, uri: cUri, group: 'then', delay: null, duration: null, args: {} });
  const results = {};
  try {
    const sf = await api.createFlow({ name: startName, folder: folderId, trigger: { id: `${APP_URI}:${startCardId}`, args: { [tokenName]: deviceId } }, conditions: [], actions: [makeAction(startActId, startCardUri)] });
    results.startFlowId = sf && sf.id;
  } catch (e) { return { folderId, startFlowError: e.message }; }
  try {
    const ef = await api.createFlow({ name: stopName, folder: folderId, trigger: { id: `${APP_URI}:${stopCardId}`, args: { [tokenName]: deviceId } }, conditions: [], actions: [makeAction(stopActId, stopCardUri)] });
    results.stopFlowId = ef && ef.id;
  } catch (e) { return { folderId, startFlowId: results.startFlowId, stopFlowError: e.message }; }
  return { folderId, ...results };
}

module.exports = {

  /**
   * GET /debug/devices
   * Returns all Modbus devices with their current capability values and settings.
   */
  async getDebugDevices({ homey }) {
    const result = [];

    for (const driverId of MODBUS_DRIVER_IDS) {
      let driver;
      try {
        driver = homey.drivers.getDriver(driverId);
      } catch {
        continue; // driver not installed or no devices
      }

      const devices = driver.getDevices();
      for (const device of devices) {
        const capabilities = {};
        for (const capId of device.getCapabilities()) {
          capabilities[capId] = device.getCapabilityValue(capId);
        }

        // Build static register definitions (address, type, label) sorted by address
        const registerDefs = {};
        for (const [groupName, registers] of Object.entries(DRIVER_REGISTER_SETS[driverId] || {})) {
          registerDefs[groupName] = Object.entries(registers)
            .map(([key, def]) => ({ key, address: def[0], length: def[1], type: def[2], label: def[3] }))
            .sort((a, b) => a.address - b.address);
        }

        result.push({
          driverId,
          deviceId:     device.getId(),
          name:         device.getName(),
          available:    device.getAvailable(),
          settings:     device.getSettings(),
          capabilities,
          registerDefs,
        });
      }
    }

    result.sort((a, b) => a.name.localeCompare(b.name));
    return { timestamp: new Date().toISOString(), version: APP_VERSION, devices: result };
  },

  /**
   * POST /debug/registers
   * Body: { driverId, deviceId }
   * Reads all raw register values for the given device over Modbus TCP.
   *
   * All register groups are merged into a single TCP connection so the total
   * round-trip fits well within Homey's API timeout.  Polling is paused first
   * so the connection slot is guaranteed to be free (Huawei devices only allow
   * one concurrent TCP session on port 502/6607).
   */
  async readDebugRegisters({ homey, body }) {
    const log = (...a) => { try { homey.app.log('[ReadLive]', ...a); } catch { /* no-op */ } };
    try {
      const { driverId, deviceId } = body || {};
      log(`request: driverId=${driverId} deviceId=${deviceId}`);

      if (!driverId || !deviceId) {
        return { error: 'Missing driverId or deviceId' };
      }

      let driver;
      try {
        driver = homey.drivers.getDriver(driverId);
      } catch {
        return { error: `Driver not found: ${driverId}` };
      }

      const devices = driver.getDevices();
      const device  = devices.find(d => d.getId() === deviceId);
      if (!device) return { error: 'Device not found' };

      const settings  = device.getSettings();
      const address   = settings.address;
      const port      = parseInt(settings.port,      10) || 502;
      const modbusId  = parseInt(settings.modbus_id, 10);
      const unitId    = Number.isFinite(modbusId) ? modbusId : 1;
      log(`target: ${address}:${port} unit=${unitId}`);

      if (!address) return { error: 'No IP address configured for this device' };

      const registerSets = DRIVER_REGISTER_SETS[driverId];
      if (!registerSets) return { error: `No register map defined for driver: ${driverId}` };

      // ── 1. Pause polling on all devices sharing this host ────────────────────
      const pausedDevices = [];
      for (const dId of MODBUS_DRIVER_IDS) {
        let drv;
        try { drv = homey.drivers.getDriver(dId); } catch { continue; }
        for (const dev of drv.getDevices()) {
          try {
            if ((dev.getSetting('address') || '').trim() !== address) continue;
            if (typeof dev._stopPolling === 'function') {
              await dev._stopPolling();
              pausedDevices.push(dev);
            }
          } catch { /* ignore */ }
        }
      }

      // Wait for any in-flight fetch to finish (max 2 s)
      const deadline = Date.now() + 2000;
      for (const dev of pausedDevices) {
        while (dev._fetchInProgress && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 100)); // eslint-disable-line no-promise-executor-return
        }
      }

      // ── 2. Merge all register groups into a single flat map ──────────────────
      // Use group name + NUL byte as separator so keys are unique across groups.
      // This lets us open ONE TCP connection instead of one per group.
      const merged = {};
      for (const [groupName, registers] of Object.entries(registerSets)) {
        for (const [key, def] of Object.entries(registers)) {
          merged[`${groupName}\x00${key}`] = def;
        }
      }

      // ── 3. Single probe — bypasses queue lock (safe because polling is paused) ─
      const PROBE_TIMEOUT_MS = 12000;
      log(`probing ${Object.keys(merged).length} registers…`);
      const raw = await probeModbusUnit(address, port, unitId, merged, PROBE_TIMEOUT_MS);
      log(`probe done: ${raw === null ? 'null (connection failed)' : `${Object.keys(raw).length} values`}`);

      // ── 4. Resume polling ────────────────────────────────────────────────────
      for (const dev of pausedDevices) {
        try { if (typeof dev._startPolling === 'function') await dev._startPolling(); } catch { /* ignore */ }
      }

      // ── 5. Reassemble per-group results ──────────────────────────────────────
      const result = {};
      for (const [groupName, registers] of Object.entries(registerSets)) {
        if (raw === null) {
          result[groupName] = { ok: false, error: 'Connection failed or timed out' };
          continue;
        }
        const rows = {};
        for (const [key, regDef] of Object.entries(registers)) {
          rows[key] = {
            address: regDef[0],
            length:  regDef[1],
            type:    regDef[2],
            label:   regDef[3],
            value:   raw[`${groupName}\x00${key}`] ?? null,
          };
        }
        result[groupName] = { ok: true, registers: rows };
      }

      return {
        timestamp: new Date().toISOString(),
        device:    device.getName(),
        address,
        port,
        unitId,
        groups:    result,
      };
    } catch (err) {
      return { error: `Unexpected error: ${err.message}` };
    }
  },

  // ─── Connection Tool ──────────────────────────────────────────────────────────

  /**
   * GET /scan/network
   * Returns all non-loopback IPv4 interfaces on the Homey host.
   */
  async getNetworkInfo() {
    const ifaces = os.networkInterfaces();
    const nets   = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          nets.push({ iface: name, address: addr.address, netmask: addr.netmask, cidr: addr.cidr });
        }
      }
    }
    return { networks: nets };
  },

  /**
   * POST /scan/ports
   * Body: { baseIp }   e.g. "192.168.1"
   * Scans 192.168.1.1–254 on ports 502 and 6607, returns hosts that answered.
   */
  async scanPorts({ body }) {
    const { baseIp } = body || {};
    if (!baseIp) return { error: 'Missing baseIp' };

    const PORTS      = [502, 6607];
    const TIMEOUT_MS = 400;
    const CONCURRENCY = 50;

    // TCP connect probe
    function tcpCheck(host, port) {
      return new Promise((resolve) => {
        const sock = new net.Socket();
        let done   = false;
        const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
        sock.setTimeout(TIMEOUT_MS);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error',   () => finish(false));
        sock.connect(port, host);
      });
    }

    // Build task list: all IPs × all ports
    const tasks = [];
    for (let i = 1; i <= 254; i++) {
      for (const port of PORTS) {
        tasks.push({ host: `${baseIp}.${i}`, port });
      }
    }

    // Run with limited concurrency
    const found = [];
    let idx     = 0;

    async function worker() {
      while (idx < tasks.length) {
        const { host, port } = tasks[idx++];
        const ok = await tcpCheck(host, port);
        if (ok) found.push({ host, port });
      }
    }

    const workers = Array.from({ length: CONCURRENCY }, worker);
    await Promise.all(workers);

    // Group by host
    const byHost = {};
    for (const { host, port } of found) {
      if (!byHost[host]) byHost[host] = [];
      byHost[host].push(port);
    }
    const hosts = Object.entries(byHost)
      .map(([host, ports]) => ({ host, ports }))
      .sort((a, b) => {
        const ai = parseInt(a.host.split('.')[3], 10);
        const bi = parseInt(b.host.split('.')[3], 10);
        return ai - bi;
      });

    return { hosts };
  },

  /**
   * POST /scan/modbus
   * Body: { host, port }
   * Tests unit IDs [0, 1, 2, 100] and identifies device type.
   */
  async scanModbus({ homey, body }) {
    try {
    const { host, port, unitIds } = body || {};
    if (!host || !port) return { error: 'Missing host or port' };

    const DEFAULT_UNIT_IDS = [0, 1, 2, 3, 100];
    // unitIds arrives as a comma-separated string, e.g. "0,1,100"
    const UNIT_IDS = (typeof unitIds === 'string' && unitIds.length)
      ? unitIds.split(',').map(Number).filter(n => Number.isFinite(n) && n >= 0 && n <= 255)
      : DEFAULT_UNIT_IDS;

    // Sequential probing with a gap between connections.
    // Huawei devices typically allow only ONE concurrent TCP session on port 502/6607.
    // Running in parallel causes all-but-one connections to be rejected immediately, and
    // the device then enters a half-open state that blocks the NEXT probe too.
    // Sequential + gap (1 s) gives the device time to close the previous session cleanly.
    const PROBE_TIMEOUT_MS  = 4000; // per unit ID — local LAN responds in < 1.5 s; non-responding cut off fast
    const INTER_UNIT_GAP_MS = 2000; // give the device time to fully close the previous TCP session

    // Every unit ID gets the same register set.
    // Identification is based purely on register values — not on unit ID —
    // so users who change the default unit IDs are still recognised correctly.
    const PROBE_REGISTERS = {
      modelName:            [30000, 15, 'STRING', 'Model Name (SUN2000)', 0],
      emmaPvPower:          [30354,  2, 'UINT32', 'EMMA PV Power (W)', 0],
      emmaFeedInPower:      [30358,  2, 'INT32',  'EMMA Feed-in Power (W)', 0],     // powermeter_emma_modbus
      emmaBatteryCapacity:  [30369,  2, 'UINT32', 'EMMA ESS Chargeable Capacity (kWh)', -3], // luna2000_emma_modbus
      emmaChargerRatedPow:  [30076,  2, 'UINT32', 'Smart Charger Rated Power (W)', -1], // smartcharger_emma_modbus
      luna2000Modules:      [47750,  1, 'UINT16', 'Battery modules unit 1 (> 0 = LUNA2000 present)', 0],
      sdongleConnType:      [37410,  1, 'UINT16', 'SDongle Connection Type', 0],
      sdongleLoadPower:     [37500,  2, 'UINT32', 'SDongle Load Power (W)', 0],  // house consumption — always present, day & night
      dtsuMeterStatus:      [37100,  1, 'UINT16', 'DTSU666 Meter Status (1 = online)', 0],
    };

    const CONN_TYPE_LABEL = { 0: 'N/A', 2: 'WLAN', 3: '4G', 4: 'WLAN-FE', 5: 'WLAN-FE' };

    // All 8 drivers are always checked and always included in the result.
    // confirmed: true  → register proof found  (shown green  ⚡)
    // confirmed: false → register not found     (shown yellow ⚠️ with Retry button)
    function identifyFromData(unitId, data) {
      const name        = typeof data.modelName === 'string' ? data.modelName.replace(/\x00/g, '').trim() : '';
      const lunaModules = data.luna2000Modules;
      const dtsuStatus  = data.dtsuMeterStatus;
      const emmaPvPow   = data.emmaPvPower;
      const emmaBatCap  = data.emmaBatteryCapacity;
      const emmaFeedIn  = data.emmaFeedInPower;
      const chargerPow  = data.emmaChargerRatedPow;
      const ct          = data.sdongleConnType;

      const lunaConf      = typeof lunaModules === 'number' && lunaModules > 0;
      const dtsuConf      = dtsuStatus === 1;
      const emmaConf      = emmaPvPow !== null && emmaPvPow !== undefined && emmaPvPow < 1e9;
      const lunaEmmaConf  = typeof emmaBatCap === 'number' && emmaBatCap !== null;
      const meterEmmaConf = emmaFeedIn !== null && emmaFeedIn !== undefined && Math.abs(emmaFeedIn) < 1e9;
      const chargerConf   = typeof chargerPow === 'number' && chargerPow > 0 && chargerPow < 100000;
      // SDongle: connection type must be an active type (≥ 2 = WLAN/4G/WLAN-FE),
      // AND PV power register 37498 must return a plausible value.
      // ct = 0 (N/A) is returned by many non-SDongle devices and is excluded.
      // SDongle: connection type (37410) must be present AND load power (37500) must return a value.
      // loadPower = house consumption — always defined on SDongle regardless of time of day,
      // and not part of the SUN2000 register space (SUN2000 returns null/exception for 37500).
      const sdongleLoadPow = data.sdongleLoadPower;
      // ct must be an active connection type (2 = WLAN, 3 = 4G, 4/5 = WLAN-FE).
      // ct = 0 means "N/A" and is returned by non-SDongle devices (e.g. SUN2000) — excluded.
      // loadPower must be > 0: SUN2000 returns 0 for register 37500; a real SDongle always has house consumption.
      const sdongleConf    = ct !== null && ct !== undefined && ct >= 2 && ct <= 5
                          && sdongleLoadPow !== null && sdongleLoadPow !== undefined
                          && sdongleLoadPow > 0 && sdongleLoadPow < 1e9;

      const compatible = [
        // ── Direct Modbus drivers ─────────────────────────────────────────────
        {
          driver:    `sun2000_modbus (Unit ID ${unitId})`,
          confirmed: !!name,
          detail:    name
            ? `Register 30000 (model name) = "${name}"`
            : `Register 30000 (model name) = ${data.modelName ?? 'null'} — not found`,
        },
        {
          driver:    `luna2000_modbus (Unit ID ${unitId})`,
          confirmed: lunaConf,
          detail:    lunaConf
            ? `Register 47750 (battery modules unit 1) = ${lunaModules}`
            : `Register 47750 (battery modules unit 1) = ${lunaModules ?? 'null'} — not found`,
        },
        {
          driver:    `dtsu666_modbus (Unit ID ${unitId})`,
          confirmed: dtsuConf,
          detail:    dtsuConf
            ? `Register 37100 (meter status) = 1 (online)`
            : `Register 37100 (meter status) = ${dtsuStatus ?? 'null'} — not found`,
        },
        {
          driver:    `sdongle_a_modbus (Unit ID ${unitId})`,
          confirmed: sdongleConf,
          detail:    sdongleConf
            ? `Register 37410 (connection type) = ${CONN_TYPE_LABEL[ct] ?? ct}, Register 37500 (load power) = ${sdongleLoadPow} W`
            : `Register 37410 (connection type) = ${ct ?? 'null'}, Register 37500 (load power) = ${sdongleLoadPow ?? 'null'} — not confirmed`,
        },
        // ── EMMA gateway drivers ──────────────────────────────────────────────
        {
          driver:    `sun2000_emma_modbus (Unit ID ${unitId})`,
          confirmed: emmaConf,
          detail:    emmaConf
            ? `Register 30354 (PV power) = ${emmaPvPow} W`
            : `Register 30354 (PV power) = ${emmaPvPow ?? 'null'} — not found`,
        },
        {
          driver:    `luna2000_emma_modbus (Unit ID ${unitId})`,
          confirmed: lunaEmmaConf,
          detail:    lunaEmmaConf
            ? `Register 30369 (ESS chargeable capacity) = ${emmaBatCap} kWh`
            : `Register 30369 (ESS chargeable capacity) = ${emmaBatCap ?? 'null'} — not found`,
        },
        {
          driver:    `powermeter_emma_modbus (Unit ID ${unitId})`,
          confirmed: meterEmmaConf,
          detail:    meterEmmaConf
            ? `Register 30358 (feed-in power) = ${emmaFeedIn} W`
            : `Register 30358 (feed-in power) = ${emmaFeedIn ?? 'null'} — not found`,
        },
        {
          driver:    `smartcharger_emma_modbus (Unit ID ${unitId})`,
          confirmed: chargerConf,
          detail:    chargerConf
            ? `Register 30076 (charger rated power) = ${chargerPow} W`
            : `Register 30076 (charger rated power) = ${chargerPow ?? 'null'} — not found`,
        },
      ];

      // Build a display label from confirmed drivers only
      const typeLabels = [];
      if (name)          typeLabels.push(name);
      if (lunaConf)      typeLabels.push('LUNA2000');
      if (dtsuConf)      typeLabels.push('DTSU666');
      if (sdongleConf)   typeLabels.push('SDongle A');
      if (emmaConf)      typeLabels.push('EMMA');
      if (lunaEmmaConf)  typeLabels.push('LUNA2000 (EMMA)');
      if (meterEmmaConf) typeLabels.push('Meter (EMMA)');
      if (chargerConf)   typeLabels.push('Smart Charger');

      return {
        type:         typeLabels.length ? typeLabels.join(' + ') : 'Unknown',
        compatible,
        anyConfirmed: typeLabels.length > 0,
      };
    }

    // ── Pause all Modbus device polling so the probe has exclusive TCP access ──
    // The finally block always restarts polling, even if the probe throws.

    // Only pause devices that share the probe target's IP address.
    // Devices on other hosts are unaffected and keep polling normally.
    const pausedDevices = [];
    for (const driverId of MODBUS_DRIVER_IDS) {
      let driver;
      try { driver = homey.drivers.getDriver(driverId); } catch { continue; }
      for (const device of driver.getDevices()) {
        try {
          const devHost = (device.getSetting('address') || '').trim();
          if (devHost !== host) continue;
          if (typeof device._stopPolling === 'function') {
            await device._stopPolling();
            pausedDevices.push(device);
          }
        } catch { /* ignore individual device errors */ }
      }
    }

    // Wait for any fetch that was already in-flight to complete (max 1.5 s)
    const waitDeadline = Date.now() + 1500;
    for (const device of pausedDevices) {
      while (device._fetchInProgress && Date.now() < waitDeadline) {
        await new Promise(r => setTimeout(r, 100)); // eslint-disable-line no-promise-executor-return
      }
    }

    const results = [];
    const log = (...args) => { try { homey.app.log('[ConnectionTool]', ...args); } catch { /* no-op */ } };

    log(`Probing ${host}:${port} — unit IDs ${UNIT_IDS.join(', ')} (${pausedDevices.length} device poll(s) paused)`);

    try {
      // Probe unit IDs sequentially with a gap so the device can close each TCP session
      // before we open the next one (single-connection Modbus servers).
      for (let i = 0; i < UNIT_IDS.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, INTER_UNIT_GAP_MS)); // eslint-disable-line no-promise-executor-return

        const unitId = UNIT_IDS[i];

        // probeModbusUnit resolves with an object when the TCP session opened,
        // or null when the connection itself failed (timeout / refused / error).
        // Individual register exceptions inside the session are captured as null values
        // in the returned object — that still counts as "responds: true".
        const data = await probeModbusUnit(host, parseInt(port, 10), unitId, PROBE_REGISTERS, PROBE_TIMEOUT_MS);

        if (data === null) {
          log(`  Unit ${unitId}: no response (connection failed / timeout)`);
          results.push({ unitId, responds: false, error: 'Connection failed' });
          continue;
        }

        const identified = identifyFromData(unitId, data);

        if (identified.anyConfirmed) {
          log(`  Unit ${unitId}: ${identified.type}`);
          log(`    Confirmed: ${identified.compatible.filter(c => c.confirmed).map(c => c.driver).join(', ')}`);
        } else {
          log(`  Unit ${unitId}: responded — no driver confirmed`);
          log(`    Raw registers: ${JSON.stringify(data)}`);
        }

        results.push({ unitId, responds: true, data, identified });
      }
    } finally {
      // Always resume polling — even if probe threw
      for (const device of pausedDevices) {
        try {
          if (typeof device._startPolling === 'function') {
            await device._startPolling();
          }
        } catch { /* ignore */ }
      }
      log(`Probe complete — ${results.filter(r => r.responds).length}/${UNIT_IDS.length} unit ID(s) responded. Polling resumed.`);
    }

    return { host, port, results, pausedCount: pausedDevices.length };
    } catch (err) {
      return { error: `Probe failed: ${err.message}` };
    }
  },

  /**
   * POST /scan/confirm
   * Body: { host, port, unitId, driver }
   * Re-reads only the confirmation registers for a specific driver.
   * Used by the Device Tester retry button on unconfirmed compatible drivers.
   */
  async confirmDriver({ homey, body }) {
    try {
      const { host, port, unitId, driver } = body || {};
      if (!host || port === undefined || unitId === undefined || !driver) {
        return { error: 'Missing host, port, unitId or driver' };
      }

      // Map base driver name → the specific registers that confirm it
      const CONN_TYPE_LABEL_C = { 0: 'N/A', 2: 'WLAN', 3: '4G', 4: 'WLAN-FE', 5: 'WLAN-FE' };
      const DRIVER_CONFIRM = {
        sun2000_modbus: {
          registers: { modelName: [30000, 15, 'STRING', 'Model Name (SUN2000)', 0] },
          check:  d => typeof d.modelName === 'string' && d.modelName.replace(/\x00/g, '').trim().length > 0,
          detail: d => `Register 30000 (model name) = "${(d.modelName || '').replace(/\x00/g, '').trim()}"`,
        },
        luna2000_modbus: {
          registers: { luna2000Modules: [47750, 1, 'UINT16', 'Battery modules unit 1', 0] },
          check:  d => typeof d.luna2000Modules === 'number' && d.luna2000Modules > 0,
          detail: d => `Register 47750 (battery modules unit 1) = ${d.luna2000Modules}`,
        },
        dtsu666_modbus: {
          registers: { dtsuMeterStatus: [37100, 1, 'UINT16', 'DTSU666 Meter Status', 0] },
          check:  d => d.dtsuMeterStatus === 1,
          detail: d => `Register 37100 (meter status) = ${d.dtsuMeterStatus}`,
        },
        sdongle_a_modbus: {
          registers: {
            sdongleConnType:  [37410, 1, 'UINT16', 'SDongle Connection Type', 0],
            sdongleLoadPower: [37500, 2, 'UINT32', 'SDongle Load Power (W)', 0],
          },
          // ct >= 2 = active connection (WLAN/4G/WLAN-FE). ct = 0 (N/A) is returned by SUN2000 — excluded.
          // loadPower > 0: SUN2000 returns 0 for register 37500; a real SDongle always has house consumption.
          check:  d => d.sdongleConnType !== null && d.sdongleConnType !== undefined
                    && d.sdongleConnType >= 2 && d.sdongleConnType <= 5
                    && d.sdongleLoadPower !== null && d.sdongleLoadPower !== undefined
                    && d.sdongleLoadPower > 0 && d.sdongleLoadPower < 1e9,
          detail: d => `Register 37410 (connection type) = ${CONN_TYPE_LABEL_C[d.sdongleConnType] ?? d.sdongleConnType}, Register 37500 (load power) = ${d.sdongleLoadPower} W`,
        },
        sun2000_emma_modbus: {
          registers: { emmaPvPower: [30354, 2, 'UINT32', 'EMMA PV Power (W)', 0] },
          check:  d => d.emmaPvPower !== null && d.emmaPvPower !== undefined && d.emmaPvPower < 1e9,
          detail: d => `Register 30354 (PV power) = ${d.emmaPvPower} W`,
        },
        luna2000_emma_modbus: {
          registers: { emmaBatteryCapacity: [30369, 2, 'UINT32', 'EMMA ESS Chargeable Capacity (kWh)', -3] },
          check:  d => typeof d.emmaBatteryCapacity === 'number' && d.emmaBatteryCapacity !== null,
          detail: d => `Register 30369 (ESS chargeable capacity) = ${d.emmaBatteryCapacity} kWh`,
        },
        powermeter_emma_modbus: {
          registers: { emmaFeedInPower: [30358, 2, 'INT32', 'EMMA Feed-in Power (W)', 0] },
          check:  d => d.emmaFeedInPower !== null && d.emmaFeedInPower !== undefined && Math.abs(d.emmaFeedInPower) < 1e9,
          detail: d => `Register 30358 (feed-in power) = ${d.emmaFeedInPower} W`,
        },
        smartcharger_emma_modbus: {
          registers: { emmaChargerRatedPow: [30076, 2, 'UINT32', 'Smart Charger Rated Power (W)', -1] },
          check:  d => typeof d.emmaChargerRatedPow === 'number' && d.emmaChargerRatedPow > 0 && d.emmaChargerRatedPow < 100000,
          detail: d => `Register 30076 (charger rated power) = ${d.emmaChargerRatedPow} W`,
        },
      };

      // Strip the "(Unit ID X)" suffix the frontend appends to driver names
      const baseDriver = driver.replace(/\s*\(Unit ID[^)]*\)/, '').trim();
      const conf = DRIVER_CONFIRM[baseDriver];
      if (!conf) return { error: `No confirmation logic for driver: ${baseDriver}` };

      // Pause devices on this host only
      const pausedDevices = [];
      for (const driverId of MODBUS_DRIVER_IDS) {
        let drv;
        try { drv = homey.drivers.getDriver(driverId); } catch { continue; }
        for (const device of drv.getDevices()) {
          try {
            if ((device.getSetting('address') || '').trim() !== host) continue;
            if (typeof device._stopPolling === 'function') {
              await device._stopPolling();
              pausedDevices.push(device);
            }
          } catch { /* ignore */ }
        }
      }

      let data;
      try {
        data = await probeModbusUnit(host, parseInt(port, 10), parseInt(unitId, 10), conf.registers, 4000);
      } finally {
        for (const device of pausedDevices) {
          try { if (typeof device._startPolling === 'function') await device._startPolling(); } catch { /* ignore */ }
        }
      }

      if (data === null) return { confirmed: false, detail: 'Connection failed or timed out' };

      const confirmed = conf.check(data);
      const detail    = conf.detail(data);
      return { confirmed, detail };
    } catch (err) {
      return { error: `Confirm failed: ${err.message}` };
    }
  },

  // ─── OpenAPI Debugger ──────────────────────────────────────────────────────

  async getOpenapiCredentials({ homey }) {
    const OPENAPI_DRIVER_IDS = [
      'sun2000_openapi_fusionsolar',
      'luna2000_openapi_fusionsolar',
      'powermeter_openapi_fusionsolar',
    ];
    for (const driverId of OPENAPI_DRIVER_IDS) {
      let driver;
      try { driver = homey.drivers.getDriver(driverId); } catch { continue; }
      for (const device of driver.getDevices()) {
        const s = device.getSettings();
        if (s.username && s.system_code) {
          return {
            baseUrl:     s.base_url || 'https://eu5.fusionsolar.huawei.com',
            username:    s.username,
            systemCode:  s.system_code,
            stationCode: s.station_code || '',
          };
        }
      }
    }
    return { baseUrl: 'https://eu5.fusionsolar.huawei.com', username: '', systemCode: '', stationCode: '' };
  },

  // ─── EMS settings API ─────────────────────────────────────────────────────────

  /** GET /ems/devices — returns all Homey devices for dropdown selection */
  async getEmsDevices({ homey }) {
    let apiKey = '';
    let diagInfo = '';
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      diagInfo = `driver found, ${devices.length} device(s)`;
      if (devices.length > 0) {
        const key = devices[0].getSetting('homey_api_key');
        diagInfo += `, key=${key ? 'set(' + key.length + ' chars)' : 'empty/null'}`;
        apiKey = key || '';
      }
    } catch (e) {
      diagInfo = `exception: ${e.message}`;
    }
    if (!apiKey) return { error: `No EMS device or API key found. Add an EMS device first. [${diagInfo}]` };

    const HomeyLocalApi = require('./lib/homey-local-api');
    const api  = new HomeyLocalApi({ homey, apiKey });
    const data = await api.getDevices();
    return Object.values(data).map((d) => ({
      id:              d.id,
      name:            d.name || '(unnamed)',
      driverId:        d.driverId || '',
      deviceClass:     d.class || '',
      capabilities:    Array.isArray(d.capabilities) ? d.capabilities : Object.keys(d.capabilities || {}),
      energyEvCharger:    !!(d.energy && d.energy.evCharger),
      energyHomeBattery:  !!(d.energy && d.energy.homeBattery),
      energyCumulative:   !!(d.energy && d.energy.cumulative),
    }));
  },

  /** GET /ems/debug — returns raw REST API fields for first 5 devices (for debugging) */
  async getEmsDebug({ homey }) {
    let apiKey = '';
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (devices.length > 0) apiKey = devices[0].getSetting('homey_api_key') || '';
    } catch { /* driver not yet paired */ }
    if (!apiKey) return { error: 'No API key' };

    const HomeyLocalApi = require('./lib/homey-local-api');
    const api  = new HomeyLocalApi({ homey, apiKey });
    const data = await api.getDevices();
    return Object.values(data).slice(0, 5).map((d) => ({
      name:         d.name,
      // Raw fields from the Homey local REST API:
      raw_class:    d.class,
      raw_driverId: d.driverId,
      raw_energy:   d.energy,
      raw_caps_type: Array.isArray(d.capabilities) ? 'array' : (d.capabilities ? 'object' : 'null/undefined'),
      raw_caps_sample: Array.isArray(d.capabilities)
        ? d.capabilities.slice(0, 4)
        : Object.keys(d.capabilities || {}).slice(0, 4),
      // All top-level keys of the raw device object:
      raw_keys: Object.keys(d).join(', '),
    }));
  },

  /** POST /ems/capability { deviceId, cap } — reads a single capability value */
  async postEmsCapabilityValue({ homey, body }) {
    const { deviceId, cap } = body || {};
    if (!deviceId || !cap) return { value: null, error: 'Missing deviceId or cap' };
    let apiKey = '';
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (devices.length > 0) apiKey = devices[0].getSetting('homey_api_key') || '';
    } catch { /* driver not yet paired */ }
    if (!apiKey) return { value: null, error: 'No API key' };
    const HomeyLocalApi = require('./lib/homey-local-api');
    const api    = new HomeyLocalApi({ homey, apiKey });
    const device = await api.getDevice(deviceId);
    if (!device) return { value: null, error: 'Device not found' };
    // capabilitiesObj is an object keyed by capability ID containing { value, ... }
    const capObj = device.capabilitiesObj || device.capabilities || {};
    const entry  = typeof capObj === 'object' && !Array.isArray(capObj) ? capObj[cap] : null;
    const value  = entry !== null && entry !== undefined
      ? (typeof entry === 'object' ? (entry.value ?? null) : entry)
      : null;
    return { value };
  },

  /** GET /ems/trigger-cards — returns all trigger cards from Homey to find the correct ID format */
  async getEmsTriggerCards({ homey }) {
    let apiKey = '';
    try {
      const driver = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (devices.length > 0) apiKey = devices[0].getSetting('homey_api_key') || '';
    } catch { }
    if (!apiKey) return { error: 'No API key' };

    const HomeyLocalApi = require('./lib/homey-local-api');
    const api = new HomeyLocalApi({ homey, apiKey });
    try {
      const raw = await api._req('GET', '/manager/flow/flowcardtrigger');
      const all = Object.values(raw || {});

      // Find cards from our app
      const ours = all.filter((c) => {
        const u = c.ownerUri || c.uri || '';
        return u.includes('fusionsolar') || (c.id || '').includes('ems_');
      });

      // Find the specific card we use for flow creation
      const targetUri = 'homey:app:com.huawei.fusionsolar';
      const found = all.find((c) =>
        (c.id === 'ems_set_charger_current' || c.id === `${targetUri}:ems_set_charger_current`) &&
        (c.ownerUri || c.uri || '') === targetUri
      );

      // Sample to understand field structure
      const sample = all.slice(0, 2);

      return {
        total:      all.length,
        ours,
        targetCard: found || null,
        targetFound: !!found,
        sample,
      };
    } catch (e) {
      return { error: e.message };
    }
  },

  /** GET /ems/debug/flow?flowId=xxx — returns the raw stored flow JSON from Homey */
  async getEmsDebugFlow({ homey, query }) {
    const flowId = query && query.flowId;

    let apiKey = '';
    try {
      const driver = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (devices.length > 0) apiKey = devices[0].getSetting('homey_api_key') || '';
    } catch { }
    if (!apiKey) return { error: 'No API key' };

    const HomeyLocalApi = require('./lib/homey-local-api');
    const api = new HomeyLocalApi({ homey, apiKey });
    try {
      if (flowId) {
        return await api._req('GET', `/manager/flow/flow/${flowId}`);
      }
      // No flowId → return compact list of all flows for browsing
      const all = await api.getFlows();
      return Object.values(all || {}).map((f) => ({
        id:      f.id,
        name:    f.name,
        folder:  f.folder,
        broken:  f.broken,
        trigger: f.trigger ? { id: f.trigger.id, uri: f.trigger.uri } : null,
        actions: (f.actions || []).map((a) => ({ id: a.id, uri: a.uri, args: a.args, droptoken: a.droptoken })),
      })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } catch (e) {
      return { error: e.message };
    }
  },

  /** GET /ems/flows — returns flows that use the ems_set_charger_current trigger */
  async getEmsFlows({ homey }) {
    let apiKey = '', emsDeviceId = '';
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (devices.length > 0) {
        apiKey      = devices[0].getSetting('homey_api_key') || '';
        emsDeviceId = devices[0].getData().id || '';
      }
    } catch { /* driver not yet paired */ }
    if (!apiKey) return { matched: [], all: [], emsDeviceId: '', error: 'No API key' };

    const HomeyLocalApi = require('./lib/homey-local-api');
    const api = new HomeyLocalApi({ homey, apiKey });
    try {
      const [flows, advFlows] = await Promise.all([
        api.getFlows().catch(() => ({})),
        api.getAdvancedFlows().catch(() => ({})),
      ]);

      function parseActionCard(a) {
        if (!a) return { cardId: null, cardUri: null };
        const rawId = a.id || '';
        if (rawId.startsWith('homey:')) {
          const lastColon = rawId.lastIndexOf(':');
          return { cardId: rawId.slice(lastColon + 1), cardUri: rawId.slice(0, lastColon) };
        }
        return { cardId: rawId, cardUri: a.uri || '' };
      }

      // Index start-charger flows by name so we can join them to the set-current flow
      const startByName = {};
      for (const [, f] of Object.entries(flows || {})) {
        const tid = f.trigger && f.trigger.id || '';
        if (tid === 'ems_start_charger' || tid.endsWith(':ems_start_charger')) {
          const { cardId, cardUri } = parseActionCard((f.actions || [])[0]);
          startByName[f.name || ''] = { startCardId: cardId, startCardUri: cardUri };
        }
      }

      const matched = [];
      for (const [id, f] of Object.entries(flows || {})) {
        const tid = f.trigger && f.trigger.id || '';
        if (tid === 'ems_set_charger_current' || tid.endsWith(':ems_set_charger_current')) {
          const { cardId, cardUri } = parseActionCard((f.actions || [])[0]);
          const startName = `${f.name || ''} → Start`;
          const startInfo = startByName[startName] || {};
          matched.push({
            id,
            name:          f.name || id,
            type:          'flow',
            actionCardId:  cardId,
            actionCardUri: cardUri,
            startCardId:   startInfo.startCardId  || null,
            startCardUri:  startInfo.startCardUri || null,
          });
        }
      }
      const advList = Object.entries(advFlows || {}).map(([id, f]) => ({
        id, name: f.name || id, type: 'advanced',
      }));

      return {
        emsDeviceId,
        matched: matched.sort((a, b) => a.name.localeCompare(b.name)),
        all:     [...matched, ...advList].sort((a, b) => a.name.localeCompare(b.name)),
      };
    } catch (e) {
      return { matched: [], all: [], error: e.message };
    }
  },

  /** GET /ems/config — returns current EMS config from homey.settings */
  async getEmsConfig({ homey }) {
    return homey.settings.get('ems_config') || {};
  },

  /** GET /ems/history — returns EMS event log for the history widget */
  async getEmsHistory({ homey }) {
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (!devices.length) return { events: [], error: 'No EMS device found' };
      const events = devices[0].getEmsHistory();
      return { events };
    } catch (e) {
      return { events: [], error: e.message };
    }
  },

  /** GET /ems/charger/action-cards?deviceId=xxx — lists action cards available for a device */
  async getEmsChargerActionCards({ homey, query }) {
    const { deviceId } = query || {};
    if (!deviceId) return { error: 'Missing deviceId' };

    let apiKey = '';
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (devices.length > 0) apiKey = devices[0].getSetting('homey_api_key') || '';
    } catch { /* driver not yet paired */ }
    if (!apiKey) return { error: 'No API key' };

    const HomeyLocalApi = require('./lib/homey-local-api');
    const api    = new HomeyLocalApi({ homey, apiKey });
    const allDevices = await api.getDevices();
    const device     = allDevices[deviceId];
    if (!device) return { error: 'Device not found' };

    // Extract app URI: "homey:app:no.easee:charger" → "homey:app:no.easee"
    const appUri = device.ownerUri
      || (device.driverId ? device.driverId.replace(/:[^:]+$/, '') : '');

    // Load all action cards and return them grouped by ownerUri
    // so the user can identify and pick the right card for their device
    let allCardList = [];
    try {
      const raw = await api._req('GET', '/manager/flow/flowcardaction');
      allCardList = Object.values(raw || {});
    } catch (_) {}

    function resolveTitle(t) {
      if (!t) return '';
      if (typeof t === 'string') return t;
      return t.en || t.de || Object.values(t)[0] || '';
    }

    // Device URI — cards for this specific device appear under this key
    const deviceUri = `homey:device:${deviceId}`;

    // Map all cards; mark those belonging to this charger device as "suggested"
    const allCards = allCardList.map((c) => {
      const cUri  = c.ownerUri || c.uri || '';
      return {
        id:        c.id,
        uri:       cUri,
        title:     resolveTitle(c.title) || c.id,
        suggested: cUri === deviceUri,
        args:      (c.args || []).map((a) => ({
          name:  a.name,
          type:  a.type,
          title: resolveTitle(a.title) || a.name,
        })),
      };
    });

    // Group all cards by URI for display
    const grouped = new Map();
    for (const c of allCards) {
      const group = grouped.get(c.uri) || [];
      group.push(c);
      grouped.set(c.uri, group);
    }

    // Build groups sorted: charger device first, then alphabetical
    const groups = [...grouped.entries()]
      .sort(([a], [b]) => {
        const aS = a === deviceUri ? 0 : 1;
        const bS = b === deviceUri ? 0 : 1;
        if (aS !== bS) return aS - bS;
        return a.localeCompare(b);
      })
      .map(([uri, cards]) => ({
        uri,
        label:     uri === deviceUri
          ? `★ ${device.name || deviceId}`
          : uri.replace('homey:app:', '').replace('homey:manager:', '').replace('homey:zone:', 'Zone '),
        suggested: uri === deviceUri,
        cards:     cards.map((c) => ({
          id:        c.id,
          uri:       c.uri,
          title:     c.title,
          suggested: c.suggested || false,
          _isCap:    c._isCap || false,
          args:      c.args,
        })),
      }));

    return {
      deviceName: device.name,
      driverId:   device.driverId,
      deviceUri,
      totalCards: allCardList.length,
      groups,
    };
  },

  /** GET /ems/charger/condition-cards?deviceId=xxx — condition cards for the charger device */
  async getEmsChargerConditionCards({ homey, query }) {
    const { deviceId } = query || {};
    if (!deviceId) return { error: 'Missing deviceId' };

    let apiKey = '';
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (devices.length > 0) apiKey = devices[0].getSetting('homey_api_key') || '';
    } catch { }
    if (!apiKey) return { error: 'No API key' };

    const HomeyLocalApi = require('./lib/homey-local-api');
    const api = new HomeyLocalApi({ homey, apiKey });

    const resolveTitle = (t) => (t && typeof t === 'object') ? (t.de || t.en || Object.values(t)[0] || '') : (t || '');

    try {
      const [allRaw, device] = await Promise.all([
        api._req('GET', '/manager/flow/flowcardcondition'),
        api.getDevice(deviceId).catch(() => null),
      ]);

      const deviceUri  = `homey:device:${deviceId}`;
      const allCards   = Object.values(allRaw || {});
      const deviceCards = allCards
        .filter((c) => (c.ownerUri || c.uri || '') === deviceUri)
        .map((c) => ({
          id:       c.id,
          uri:      deviceUri,
          title:    resolveTitle(c.title) || c.id,
          args:     (c.args || []).map((a) => ({ name: a.name, type: a.type, title: resolveTitle(a.title) || a.name })),
        }));

      return { deviceName: device && device.name, cards: deviceCards };
    } catch (e) {
      return { error: e.message };
    }
  },

  /** POST /ems/charger/setup-flows — creates "Huawei EMS" folder + ONE advanced flow per charger */
  async postEmsChargerSetupFlows({ homey, body }) {
    // emsDeviceId: the paired EMS device (owner of the trigger card)
    // deviceId / deviceName: the EV charger to control
    // actionCardId / actionCardUri: the charger's set-current action card
    // actionArgName: the arg name for current/amps (default: "current")
    const { emsDeviceId, deviceId, deviceName, actionCardId, actionCardUri, actionCardTitle, actionArgName,
            startCardId, startCardUri } = body || {};
    if (!emsDeviceId || !deviceId || !actionCardId || !actionCardUri) {
      return { error: 'Missing emsDeviceId, deviceId, actionCardId, or actionCardUri' };
    }

    let apiKey = '';
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (devices.length > 0) apiKey = devices[0].getSetting('homey_api_key') || '';
    } catch { /* driver not yet paired */ }
    if (!apiKey) return { error: 'No API key' };

    const HomeyLocalApi = require('./lib/homey-local-api');
    const api = new HomeyLocalApi({ homey, apiKey });

    // 1. Get or create "Huawei EMS" folder (optional — skip gracefully if API unavailable)
    let folderId = null;
    try {
      const folders  = await api.getFlowFolders();
      const existing = Object.values(folders || {}).find((f) => f.name === '_Huawei EMS');
      if (existing) {
        folderId = existing.id;
      } else {
        const created = await api.createFlowFolder({ name: '_Huawei EMS' });
        folderId = created && created.id ? created.id : null;
      }
    } catch (_) { /* proceed without folder */ }

    // 2. Remove any existing EMS flow for this charger (avoid duplicates)
    const cardLabel = actionCardTitle ? ` → ${actionCardTitle}` : '';
    const flowName  = `EMS: ${deviceName || deviceId}${cardLabel}`;
    try {
      const allFlows = await api.getFlows();
      await Promise.all(
        Object.values(allFlows || {})
          .filter((f) => f.name === flowName)
          .map((f) => api.deleteFlow(f.id).catch(() => {}))
      );
    } catch (_) { /* ignore — delete is best-effort */ }

    // 3. Create ONE standard flow:
    //    [ems_set_charger_current | phase1, phase2, phase3] ──► [charger action]
    const APP_URI = 'homey:app:com.huawei.fusionsolar';

    // Cards with homey:device: URI: no "device" arg (URI already identifies the device).
    // Cards with homey:app: URI: need a "device" arg to route to the correct device.
    const isDeviceUri = actionCardUri.startsWith('homey:device:');
    const argNames    = Array.isArray(actionArgName)
      ? actionArgName
      : [actionArgName || 'value'];

    // Standard flows: number args use droptoken (single token dropped onto the card),
    // text/string args use [[tokenName]] inside the arg value.
    const baseActionArgs = isDeviceUri ? {} : { device: { id: deviceId, name: deviceName || deviceId } };

    // Build per-arg values — number args get their default 0 value; droptoken handles the binding.
    // If multiple phase args: map each to their own token via [[phaseN]] (text field workaround).
    const phaseTokenNames = ['phase1', 'phase2', 'phase3'];
    let droptoken = null;

    if (argNames.length === 1) {
      // Single arg → use droptoken for the token binding (standard Homey pattern for number fields)
      droptoken = 'amps';
    } else {
      // Multiple args (per-phase) → embed token names directly
      argNames.forEach((name, i) => {
        if (name) baseActionArgs[name] = `[[${phaseTokenNames[i] || 'amps'}]]`;
      });
    }

    const flowAction = {
      id:       actionCardId,
      uri:      actionCardUri,
      group:    'then',
      delay:    null,
      duration: null,
      args:     baseActionArgs,
    };
    if (droptoken) flowAction.droptoken = droptoken;

    const trigger = { id: `${APP_URI}:ems_set_charger_current`, args: { charger_device_id: deviceId } };

    // Flow A: always fires → SET current
    const flowPayload = {
      name:       flowName,
      folder:     folderId,
      trigger,
      conditions: [],
      actions:    [flowAction],
    };

    let createdFlow;
    try {
      createdFlow = await api.createFlow(flowPayload);
    } catch (err) {
      return { error: `Flow creation failed: ${err.message}`, payload: flowPayload };
    }

    // Flow B (optional): condition "not charging" → START charging
    let startFlowId = null;
    if (startCardId && startCardUri) {
      const startFlowName = `${flowName} → Start`;
      // Delete existing start flow
      try {
        const allFlows = await api.getFlows();
        await Promise.all(
          Object.values(allFlows || {})
            .filter((f) => f.name === startFlowName)
            .map((f) => api.deleteFlow(f.id).catch(() => {}))
        );
      } catch (_) { }

      const startPayload = {
        name:       startFlowName,
        folder:     folderId,
        trigger:    { id: `${APP_URI}:ems_start_charger`, args: { charger_device_id: deviceId } },
        conditions: [],
        actions: [{
          id:       startCardId,
          uri:      startCardUri,
          group:    'then',
          delay:    null,
          duration: null,
          args:     {},
        }],
      };

      try {
        const startFlow = await api.createFlow(startPayload);
        startFlowId = startFlow && startFlow.id;
      } catch (err) {
        return { folderId, flowId: createdFlow && createdFlow.id, startFlowError: err.message };
      }
    }

    return { folderId, flowId: createdFlow && createdFlow.id, startFlowId };
  },

  /** GET /ems/heatpump/action-cards?deviceId=xxx — action cards for a heat pump device */
  async getEmsHeatPumpActionCards({ homey, query }) {
    return this.getEmsChargerActionCards({ homey, query });
  },

  /** GET /ems/heatpump/flows — flows using ems_start/stop_heat_pump triggers */
  async getEmsHeatPumpFlows({ homey }) {
    let apiKey = '', emsDeviceId = '';
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (devices.length > 0) {
        apiKey      = devices[0].getSetting('homey_api_key') || '';
        emsDeviceId = devices[0].getData().id || '';
      }
    } catch { }
    if (!apiKey) return { matched: [], error: 'No API key' };

    const HomeyLocalApi = require('./lib/homey-local-api');
    const api = new HomeyLocalApi({ homey, apiKey });
    try {
      const flows = await api.getFlows().catch(() => ({}));
      const matched = [];
      for (const [id, f] of Object.entries(flows || {})) {
        const tid = f.trigger && f.trigger.id || '';
        if (tid.endsWith(':ems_start_heat_pump') || tid.endsWith(':ems_stop_heat_pump')
            || tid === 'ems_start_heat_pump' || tid === 'ems_stop_heat_pump') {
          const firstAction = (f.actions || [])[0];
          let cardId = null, cardUri = null;
          if (firstAction) {
            const rawId = firstAction.id || '';
            if (rawId.startsWith('homey:')) {
              const lastColon = rawId.lastIndexOf(':');
              cardId  = rawId.slice(lastColon + 1);
              cardUri = rawId.slice(0, lastColon);
            } else {
              cardId  = rawId;
              cardUri = firstAction.uri || '';
            }
          }
          matched.push({
            id, name: f.name || id, type: 'flow',
            triggerType:   (tid.endsWith(':ems_start_heat_pump') || tid === 'ems_start_heat_pump') ? 'start' : 'stop',
            actionCardId:  cardId,
            actionCardUri: cardUri,
          });
        }
      }
      return { emsDeviceId, matched: matched.sort((a, b) => a.name.localeCompare(b.name)) };
    } catch (e) {
      return { matched: [], error: e.message };
    }
  },

  /** POST /ems/heatpump/setup-flows — creates start + stop flows for a heat pump */
  async postEmsHeatPumpSetupFlows({ homey, body }) {
    const { emsDeviceId, deviceId, deviceName, startCardId, startCardUri, stopCardId, stopCardUri } = body || {};
    if (!emsDeviceId || !deviceId || !startCardId || !startCardUri || !stopCardId || !stopCardUri) {
      return { error: 'Missing required fields (emsDeviceId, deviceId, startCardId, startCardUri, stopCardId, stopCardUri)' };
    }

    let apiKey = '';
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      const devices = driver.getDevices();
      if (devices.length > 0) apiKey = devices[0].getSetting('homey_api_key') || '';
    } catch { }
    if (!apiKey) return { error: 'No API key' };

    const HomeyLocalApi = require('./lib/homey-local-api');
    const APP_URI = 'homey:app:com.huawei.fusionsolar';
    const api = new HomeyLocalApi({ homey, apiKey });

    // Get or create "_Huawei EMS" folder
    let folderId = null;
    try {
      const folders  = await api.getFlowFolders();
      const existing = Object.values(folders || {}).find((f) => f.name === '_Huawei EMS');
      folderId = existing ? existing.id : (await api.createFlowFolder({ name: '_Huawei EMS' }))?.id || null;
    } catch (_) { }

    const baseName  = `EMS: ${deviceName || deviceId}`;
    const startName = `${baseName} → Heat Pump Start`;
    const stopName  = `${baseName} → Heat Pump Stop`;

    // Delete existing flows with same names
    const allFlows = await api.getFlows().catch(() => ({}));
    await Promise.all(
      Object.values(allFlows || {})
        .filter((f) => f.name === startName || f.name === stopName)
        .map((f) => api.deleteFlow(f.id).catch(() => {})),
    );

    const makeAction = (cardId, cardUri) => ({
      id: cardId, uri: cardUri, group: 'then', delay: null, duration: null, args: {},
    });

    const results = {};
    try {
      const sf = await api.createFlow({
        name: startName, folder: folderId,
        trigger: { id: `${APP_URI}:ems_start_heat_pump`, args: { heat_pump_device_id: deviceId } },
        conditions: [],
        actions: [makeAction(startCardId, startCardUri)],
      });
      results.startFlowId = sf && sf.id;
    } catch (e) { return { folderId, startFlowError: e.message }; }

    try {
      const ef = await api.createFlow({
        name: stopName, folder: folderId,
        trigger: { id: `${APP_URI}:ems_stop_heat_pump`, args: { heat_pump_device_id: deviceId } },
        conditions: [],
        actions: [makeAction(stopCardId, stopCardUri)],
      });
      results.stopFlowId = ef && ef.id;
    } catch (e) { return { folderId, startFlowId: results.startFlowId, stopFlowError: e.message }; }

    return { folderId, ...results };
  },

  /** GET /ems/battery/action-cards — marks luna2000 battery cards as suggested */
  async getEmsBatteryActionCards({ homey, query }) {
    const base = await this.getEmsChargerActionCards({ homey, query });
    if (base.error) return base;
    const SUGGESTED = new Set([
      'luna2000_start_force_charge',
      'luna2000_start_force_discharge',
      'luna2000_set_working_mode',
      'luna2000_set_max_charge_power',
      'luna2000_set_max_discharge_power',
    ]);
    (base.groups || []).forEach((g) => {
      (g.cards || []).forEach((c) => { if (SUGGESTED.has(c.id)) c.suggested = true; });
    });
    return base;
  },

  /** GET /ems/battery/flows?deviceId=xxx */
  async getEmsBatteryFlows({ homey, query }) {
    const { deviceId } = query || {};
    if (!deviceId) return { matched: [], error: 'Missing deviceId' };
    let apiKey = '';
    try {
      const [dev] = homey.drivers.getDriver('energy_management').getDevices();
      if (dev) apiKey = dev.getSetting('homey_api_key') || '';
    } catch { }
    if (!apiKey) return { matched: [], error: 'No API key — configure EMS device first' };
    const HomeyLocalApi = require('./lib/homey-local-api');
    const APP_URI = 'homey:app:com.huawei.fusionsolar';
    function parseAction(a) {
      const rawId = a.id || '';
      if (rawId.startsWith('homey:')) { const lc = rawId.lastIndexOf(':'); return { cardId: rawId.slice(lc + 1), cardUri: rawId.slice(0, lc) }; }
      return { cardId: rawId, cardUri: a.uri || '' };
    }
    try {
      const api = new HomeyLocalApi({ homey, apiKey });
      const allFlows = await api.getFlows();
      let deviceName = deviceId;
      try { const d = await api.getDevices(); deviceName = d[deviceId]?.name || deviceId; } catch { }
      const namePrefix = `EMS: ${deviceName} → `;
      const matched = [];
      for (const flow of Object.values(allFlows || {})) {
        if (!flow.name || !flow.name.startsWith(namePrefix)) continue;
        const firstAction = (flow.actions || []).find((a) => { const { cardUri } = parseAction(a); return !cardUri || cardUri === APP_URI; });
        const { cardId, cardUri } = firstAction ? parseAction(firstAction) : { cardId: '', cardUri: '' };
        const { device: _d, ...restArgs } = firstAction?.args || {};
        matched.push({ id: flow.id, name: flow.name, actionCardId: cardId || null, actionCardUri: cardUri || null, cardArgs: restArgs });
      }
      return { matched };
    } catch (e) { return { matched: [], error: e.message }; }
  },

  /** POST /ems/battery/setup-flows — creates one flow per entry, same pattern as postInverterSetupFlow */
  async postEmsBatterySetupFlows({ homey, body }) {
    const { deviceId, flows } = body || {};
    if (!deviceId || !Array.isArray(flows) || !flows.length) return { error: 'Missing deviceId or flows array' };
    let apiKey = '';
    try {
      const [dev] = homey.drivers.getDriver('energy_management').getDevices();
      if (dev) apiKey = dev.getSetting('homey_api_key') || '';
    } catch { }
    if (!apiKey) return { error: 'No API key — configure EMS device first' };
    const HomeyLocalApi = require('./lib/homey-local-api');
    const APP_URI = 'homey:app:com.huawei.fusionsolar';
    const api = new HomeyLocalApi({ homey, apiKey });
    let folderId = null;
    try {
      const folders = await api.getFlowFolders();
      const existing = Object.values(folders || {}).find((f) => f.name === '_Huawei EMS');
      folderId = existing ? existing.id : (await api.createFlowFolder({ name: '_Huawei EMS' }))?.id || null;
    } catch (_) { }
    let deviceName = deviceId;
    try { const d = await api.getDevices(); deviceName = d[deviceId]?.name || deviceId; } catch { }
    const allFlows = await api.getFlows().catch(() => ({}));
    const names = new Set(flows.map((f) => `EMS: ${deviceName} → ${f.name}`));
    await Promise.all(Object.values(allFlows || {}).filter((f) => names.has(f.name)).map((f) => api.deleteFlow(f.id).catch(() => {})));
    const results = [];
    for (const def of flows) {
      const flowName = `EMS: ${deviceName} → ${def.name}`;
      const action = { id: def.cardId, uri: def.cardUri, group: 'then', delay: null, duration: null, args: { device: { id: deviceId }, ...(def.cardArgs || {}) } };
      const trigger = def.triggerId
        ? { id: `${APP_URI}:${def.triggerId}`, args: { battery_device_id: deviceId } }
        : { id: 'homey:manager:flow:start', args: {} };
      let created = null; let lastErr = null;
      try { created = await api.createFlow({ name: flowName, folder: folderId, trigger, conditions: [], actions: [action] }); } catch (err) { lastErr = err.message; }
      results.push({ name: flowName, flowId: created?.id, ok: !!created?.id, error: lastErr });
    }
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    if (ok === 0) return { error: `All flows failed: ${results[0]?.error || 'rejected by Homey API'}`, results };
    return { folderId, results, created: ok, note: failed.length ? `${failed.length} flow(s) failed` : 'Add a trigger to each flow in Homey' };
  },

  /** GET /ems/boiler/action-cards */
  async getEmsBoilerActionCards({ homey, query }) { return this.getEmsChargerActionCards({ homey, query }); },
  /** GET /ems/boiler/flows */
  async getEmsBoilerFlows({ homey }) {
    return _getEmsSimpleDeviceFlows({ homey, startCardId: 'ems_start_boiler', stopCardId: 'ems_stop_boiler', startTokenName: 'boiler_device_id' });
  },
  /** POST /ems/boiler/setup-flows */
  async postEmsBoilerSetupFlows({ homey, body }) {
    return _postEmsSimpleDeviceSetupFlows({ homey, body, startCardId: 'ems_start_boiler', stopCardId: 'ems_stop_boiler', tokenName: 'boiler_device_id', labelSuffix: 'Boiler' });
  },

  /** GET /ems/pool/action-cards */
  async getEmsPoolActionCards({ homey, query }) { return this.getEmsChargerActionCards({ homey, query }); },
  /** GET /ems/pool/flows */
  async getEmsPoolFlows({ homey }) {
    return _getEmsSimpleDeviceFlows({ homey, startCardId: 'ems_start_pool', stopCardId: 'ems_stop_pool', startTokenName: 'pool_device_id' });
  },
  /** POST /ems/pool/setup-flows */
  async postEmsPoolSetupFlows({ homey, body }) {
    return _postEmsSimpleDeviceSetupFlows({ homey, body, startCardId: 'ems_start_pool', stopCardId: 'ems_stop_pool', tokenName: 'pool_device_id', labelSuffix: 'Pool' });
  },

  /** GET /ems/dehumidifier/action-cards */
  async getEmsDehumidifierActionCards({ homey, query }) { return this.getEmsChargerActionCards({ homey, query }); },
  /** GET /ems/dehumidifier/flows */
  async getEmsDehumidifierFlows({ homey }) {
    return _getEmsSimpleDeviceFlows({ homey, startCardId: 'ems_start_dehumidifier', stopCardId: 'ems_stop_dehumidifier', startTokenName: 'dehumidifier_device_id' });
  },
  /** POST /ems/dehumidifier/setup-flows */
  async postEmsDehumidifierSetupFlows({ homey, body }) {
    return _postEmsSimpleDeviceSetupFlows({ homey, body, startCardId: 'ems_start_dehumidifier', stopCardId: 'ems_stop_dehumidifier', tokenName: 'dehumidifier_device_id', labelSuffix: 'Dehumidifier' });
  },

  /**
   * GET /inverter/action-cards?deviceId=xxx
   * Like getEmsChargerActionCards but marks sun2000 export-limit cards as suggested.
   */
  async getInverterActionCards({ homey, query }) {
    const base = await this.getEmsChargerActionCards({ homey, query });
    if (base.error) return base;

    const APP_URI = 'homey:app:com.huawei.fusionsolar';
    const SUN2000_SUGGESTED = new Set([
      'sun2000_set_export_limit_enabled',
      'sun2000_set_max_feed_in_power',
      'sun2000_set_max_feed_in_power_pct',
      'sun2000_set_active_power_derating_w',
      'sun2000_set_active_power_derating_pct',
      'sun2000_reset_output_limit',
    ]);

    base.groups = base.groups.map((g) => {
      const isAppGroup = g.uri === APP_URI;
      return {
        ...g,
        label:     isAppGroup ? `★ FusionSolar (${base.deviceName || 'Inverter'})` : g.label,
        suggested: isAppGroup || g.suggested,
        cards: g.cards.map((c) => ({
          ...c,
          suggested: (isAppGroup && SUN2000_SUGGESTED.has(c.id)) || c.suggested,
        })),
      };
    });

    // Sort so FusionSolar group appears first
    base.groups.sort((a, b) => {
      if (a.uri === APP_URI) return -1;
      if (b.uri === APP_URI) return 1;
      return 0;
    });

    return base;
  },

  /** GET /inverter/flows?deviceId=xxx — finds EMS inverter flows by name prefix */
  async getInverterFlows({ homey, query }) {
    const { deviceId } = query || {};
    if (!deviceId) return { matched: [], error: 'Missing deviceId' };

    let apiKey = '';
    try {
      const [dev] = homey.drivers.getDriver('energy_management').getDevices();
      if (dev) apiKey = dev.getSetting('homey_api_key') || '';
    } catch { }
    if (!apiKey) return { matched: [], error: 'No API key — configure EMS device first' };

    const HomeyLocalApi = require('./lib/homey-local-api');
    const APP_URI = 'homey:app:com.huawei.fusionsolar';

    // Normalize full-URI action id ("homey:app:...:card_id") to short form.
    function parseAction(a) {
      const rawId = a.id || '';
      if (rawId.startsWith('homey:')) {
        const lastColon = rawId.lastIndexOf(':');
        return { cardId: rawId.slice(lastColon + 1), cardUri: rawId.slice(0, lastColon) };
      }
      return { cardId: rawId, cardUri: a.uri || '' };
    }

    try {
      const api      = new HomeyLocalApi({ homey, apiKey });
      const allFlows = await api.getFlows();

      // Resolve device name for name-based matching (same prefix used when creating flows)
      let deviceName = deviceId;
      try {
        const allDevices = await api.getDevices();
        deviceName = allDevices[deviceId]?.name || deviceId;
      } catch { }
      const namePrefix = `EMS: ${deviceName} → `;

      const matched = [];
      for (const flow of Object.values(allFlows || {})) {
        if (!flow.name || !flow.name.startsWith(namePrefix)) continue;
        // Extract action card info so _tryInvPrefill can pre-select dropdowns
        const firstAction = (flow.actions || []).find((a) => {
          const { cardUri } = parseAction(a);
          return !cardUri || cardUri === APP_URI;
        });
        const { cardId, cardUri } = firstAction ? parseAction(firstAction) : { cardId: '', cardUri: '' };
        const { device: _d, ...restArgs } = firstAction?.args || {};
        matched.push({
          id: flow.id, name: flow.name,
          actionCardId:  cardId || null,
          actionCardUri: cardUri || null,
          cardArgs:      restArgs,
        });
      }
      return { matched };
    } catch (e) {
      return { matched: [], error: e.message };
    }
  },

  /**
   * POST /inverter/setup-flow
   * body.flows = [{ name, cardId, cardUri, cardArgs }]
   * Creates one flow per entry in "_Huawei EMS". Re-running overwrites by name.
   */
  async postInverterSetupFlow({ homey, body }) {
    const { deviceId, flows } = body || {};
    if (!deviceId || !Array.isArray(flows) || !flows.length) {
      return { error: 'Missing deviceId or flows array' };
    }

    let apiKey = '', emsDeviceId = '', emsDeviceName = '';
    try {
      const [dev] = homey.drivers.getDriver('energy_management').getDevices();
      if (dev) {
        apiKey        = dev.getSetting('homey_api_key') || '';
        emsDeviceId   = dev.id;
        emsDeviceName = dev.getName();
      }
    } catch { }
    if (!apiKey) return { error: 'No API key — configure EMS device first' };

    const HomeyLocalApi = require('./lib/homey-local-api');
    const APP_URI = 'homey:app:com.huawei.fusionsolar';
    const api = new HomeyLocalApi({ homey, apiKey });

    let folderId = null;
    try {
      const folders  = await api.getFlowFolders();
      const existing = Object.values(folders || {}).find((f) => f.name === '_Huawei EMS');
      folderId = existing ? existing.id : (await api.createFlowFolder({ name: '_Huawei EMS' }))?.id || null;
    } catch (_) { }

    // Resolve inverter device name for flow name prefix (must happen before delete)
    let deviceName = deviceId;
    try {
      const allDevices = await api.getDevices();
      deviceName = allDevices[deviceId]?.name || deviceId;
    } catch { }

    const allFlows = await api.getFlows().catch(() => ({}));
    const names    = new Set(flows.map((f) => `EMS: ${deviceName} → ${f.name}`));
    await Promise.all(
      Object.values(allFlows || {}).filter((f) => names.has(f.name))
        .map((f) => api.deleteFlow(f.id).catch(() => {})),
    );

    const results = [];
    for (const def of flows) {
      const flowName = `EMS: ${deviceName} → ${def.name}`;
      const action = {
        id: def.cardId, uri: def.cardUri, group: 'then', delay: null, duration: null,
        args: { device: { id: deviceId }, ...(def.cardArgs || {}) },
      };
      let created = null;
      let lastErr  = null;
      const trigger = def.triggerId
        ? { id: `${APP_URI}:${def.triggerId}`, args: { inverter_device_id: deviceId } }
        : (def.trigger || { id: 'homey:manager:flow:start', args: {} });
      try {
        created = await api.createFlow({
          name: flowName, folder: folderId, trigger, conditions: [], actions: [action],
        });
      } catch (err) { lastErr = err.message; }
      results.push({ name: flowName, flowId: created?.id, ok: !!created?.id, error: lastErr });
    }

    const ok     = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    if (ok === 0) {
      const firstErr = results[0]?.error || 'Flow creation rejected by Homey API';
      return { error: `All flows failed: ${firstErr}`, results };
    }
    return {
      folderId,
      results,
      created: ok,
      note: failed.length
        ? `${failed.length} flow(s) failed — add manually in Homey`
        : 'Add a trigger (e.g. price app) to each flow in Homey',
    };
  },

  /** PUT /ems/config — saves EMS config and notifies the device to reload */
  async putEmsConfig({ homey, body }) {
    homey.settings.set('ems_config', body);
    try {
      const driver  = homey.drivers.getDriver('energy_management');
      for (const device of driver.getDevices()) {
        if (typeof device.onConfigChanged === 'function') device.onConfigChanged();
      }
    } catch { /* device not ready */ }
    return { ok: true };
  },

  async fetchOpenapiDebug({ body }) {
    const { baseUrl, username, systemCode } = body || {};
    if (!baseUrl || !username || !systemCode) {
      return { error: 'Missing baseUrl, username or systemCode' };
    }

    const result = { timestamp: new Date().toISOString(), baseUrl, steps: [] };

    try {
      const token = await openapiLogin(baseUrl, username, systemCode);
      result.steps.push({ step: 'login', ok: true });

      const { stations } = await openapiGetStationList(baseUrl, token);
      result.steps.push({ step: 'getStationList', ok: true, data: stations });
      result.stations = stations;

      if (!stations.length) {
        result.steps.push({ step: 'note', ok: true, data: 'No stations found — cannot fetch devices.' });
        return result;
      }

      result.stationDetails = [];

      for (const station of stations) {
        const code = station.plantCode ?? station.stationCode;
        if (!code) continue;

        const stationResult = { stationCode: code, stationName: station.plantName ?? station.stationName ?? code };

        try {
          const { raw } = await openapiGetStationRealKpiRaw(baseUrl, token, code);
          stationResult.stationKpi = raw;
          result.steps.push({ step: `getStationRealKpi(${code})`, ok: true, data: raw ? 'data received' : 'no data' });
        } catch (err) {
          stationResult.stationKpi = null;
          result.steps.push({ step: `getStationRealKpi(${code})`, ok: false, data: err.message });
        }

        const { devices } = await openapiGetDevList(baseUrl, token, code);
        stationResult.devices = devices;
        result.steps.push({ step: `getDevList(${code})`, ok: true, data: `${devices.length} device(s)` });

        const byType = {};
        for (const d of devices) {
          const t = Number(d.devTypeId);
          if (!byType[t]) byType[t] = [];
          byType[t].push(String(d.id));
        }

        stationResult.kpiByType = {};
        const kpiEntries = Object.entries(byType);
        const kpiResults = await Promise.allSettled(
          kpiEntries.map(([typeId, ids]) =>
            openapiGetDevRealKpi(baseUrl, token, ids, Number(typeId))
              .then(({ devices: kpiDevices }) => ({ typeId, kpiDevices, ok: true }))
              .catch((err) => ({ typeId, error: err.message, ok: false })),
          ),
        );
        for (const settled of kpiResults) {
          const r = settled.status === 'fulfilled' ? settled.value : { typeId: '?', ok: false, error: settled.reason?.message };
          if (r.ok) {
            stationResult.kpiByType[r.typeId] = r.kpiDevices;
            result.steps.push({ step: `getDevRealKpi(type=${r.typeId})`, ok: true, data: `${r.kpiDevices.length} device(s)` });
          } else {
            stationResult.kpiByType[r.typeId] = { error: r.error };
            result.steps.push({ step: `getDevRealKpi(type=${r.typeId})`, ok: false, data: r.error });
          }
        }

        result.stationDetails.push(stationResult);
      }
    } catch (err) {
      result.steps.push({ step: 'error', ok: false, data: err.message });
      result.error = err.message;
    }

    return result;
  },

};
