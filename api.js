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
      modelName:       [30000, 15, 'STRING', 'Model Name (SUN2000)', 0],
      emmaPvPower:     [30354,  2, 'UINT32', 'EMMA PV Power (W)', 0],
      emmaSoc:         [30368,  1, 'UINT16', 'EMMA Battery SoC (%)', -2],
      luna2000Type:    [47106,  1, 'UINT16', 'Battery type (2 = LUNA2000)', 0],
      sdongleConnType: [37410,  1, 'UINT16', 'SDongle Connection Type', 0],
      sdonglePvPower:  [37498,  2, 'UINT32', 'SDongle PV Input Power (W)', 0],
    };

    const CONN_TYPE_LABEL = { 0: 'N/A', 2: 'WLAN', 3: '4G', 4: 'WLAN-FE', 5: 'WLAN-FE' };

    // Priority: SUN2000 (model string) → EMMA (PV power at 30354) → SDongle (conn type at 37410).
    // LUNA2000 is detected via register 47106 == 2 and is added to compatible drivers
    // whenever present, either alongside a SUN2000 or as a standalone battery device.
    function identifyFromData(unitId, data) {
      const hasLuna = data.luna2000Type === 2;

      // 1. SUN2000 / Inverter — non-empty model name string in register 30000
      const name = typeof data.modelName === 'string' ? data.modelName.replace(/\x00/g, '').trim() : '';
      if (name) {
        const compatible = [
          `sun2000_modbus (Unit ID ${unitId})`,
          `dtsu666_modbus (Unit ID ${unitId})`,
        ];
        if (hasLuna) compatible.splice(1, 0, `luna2000_modbus (Unit ID ${unitId})`);
        const detail = hasLuna ? `Model: ${name}  +  LUNA2000 battery` : `Model: ${name}`;
        return { type: name, detail, compatible };
      }

      // 1b. LUNA2000 standalone — register 47106 == 2 but no inverter model name
      if (hasLuna) {
        return {
          type: 'LUNA2000',
          detail: 'Battery detected via register 47106',
          compatible: [`luna2000_modbus (Unit ID ${unitId})`],
        };
      }

      // 2. EMMA — PV power register 30354 returns a plausible value (0 – 999 999 W)
      if (data.emmaPvPower !== null && data.emmaPvPower !== undefined && data.emmaPvPower < 1e9) {
        return {
          type: 'EMMA',
          detail: `PV: ${data.emmaPvPower} W  SoC: ${data.emmaSoc ?? '?'}%`,
          compatible: [
            `sun2000_emma_modbus (Unit ID ${unitId})`,
            `luna2000_emma_modbus (Unit ID ${unitId})`,
            `powermeter_emma_modbus (Unit ID ${unitId})`,
            `smartcharger_emma_modbus (Unit ID ${unitId})`,
          ],
        };
      }

      // 3. SDongle A — connection type register 37410 returns a known value (0–5)
      const ct = data.sdongleConnType;
      if (ct !== null && ct !== undefined && ct <= 5) {
        return {
          type: 'SDongle A',
          detail: `Connection: ${CONN_TYPE_LABEL[ct] ?? ct}`,
          compatible: [`sdongle_a_modbus (Unit ID ${unitId})`],
        };
      }

      // Connected but no register pattern matched.
      // This often means the unit ID is forwarded by a Modbus gateway (e.g. SDongle)
      // but the RS485 slave didn't return the expected registers — either because the
      // device uses a non-standard register layout, requires authentication, or the
      // unit ID maps to a different device type.  Return a soft "possible" match so
      // the user still gets actionable driver suggestions to try manually.
      return {
        type: 'Unknown (gateway sub-device?)',
        detail: 'Responded but no identifying registers matched — try drivers below manually',
        unconfirmed: true,
        compatible: [
          `sun2000_modbus (Unit ID ${unitId})`,
          `luna2000_modbus (Unit ID ${unitId})`,
          `dtsu666_modbus (Unit ID ${unitId})`,
        ],
      };
    }

    // ── Pause all Modbus device polling so the probe has exclusive TCP access ──
    // The finally block always restarts polling, even if the probe throws.

    const pausedDevices = [];
    for (const driverId of MODBUS_DRIVER_IDS) {
      let driver;
      try { driver = homey.drivers.getDriver(driverId); } catch { continue; }
      for (const device of driver.getDevices()) {
        try {
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

        if (identified && !identified.unconfirmed) {
          log(`  Unit ${unitId}: ${identified.type} — ${identified.detail}`);
          log(`    Compatible: ${identified.compatible.join(', ')}`);
        } else if (identified && identified.unconfirmed) {
          log(`  Unit ${unitId}: responded — unidentified (gateway sub-device?)`);
          log(`    Raw registers: ${JSON.stringify(data)}`);
        } else {
          log(`  Unit ${unitId}: responded — no pattern matched`);
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

};
