'use strict';

const net = require('net');
const os  = require('os');

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
   */
  async readDebugRegisters({ homey, body }) {
    try {
    const { driverId, deviceId } = body || {};

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

    if (!address) return { error: 'No IP address configured for this device' };

    const registerSets = DRIVER_REGISTER_SETS[driverId];
    if (!registerSets) return { error: `No register map defined for driver: ${driverId}` };

    const result = {};

    for (const [groupName, registers] of Object.entries(registerSets)) {
      try {
        const data = await readModbusRegisters(address, port, unitId, registers);
        const rows = {};
        for (const [key, regDef] of Object.entries(registers)) {
          rows[key] = {
            address: regDef[0],
            length:  regDef[1],
            type:    regDef[2],
            label:   regDef[3],
            value:   data[key] ?? null,
          };
        }
        result[groupName] = { ok: true, registers: rows };
      } catch (err) {
        result[groupName] = { ok: false, error: err.message };
      }
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

};
