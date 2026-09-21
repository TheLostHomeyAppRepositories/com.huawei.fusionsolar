'use strict';

// The MAC address as a label and as an anchor. Run: node --test
//
// Two jobs, one fact. A port scan can only say "something here answered on 502" — a NAS, a
// KNX gateway and a heat pump all answer that, so the list of addresses is where the
// guessing starts. The first three bytes of a MAC say who built the network interface, and
// that is the label. For a device that is already paired the whole MAC says something
// better: that the box at this address is the very one whose address stopped working.
//
// The line these tests defend is the one between the two. A label may decorate a row a
// person reads; it must never decide anything. Huawei sells phones and routers under the
// same prefixes it sells inverters under, so "Huawei" is a hint, and the proof of what a
// device is stays what it always was — reading a register it has to answer.
//
// The anchor has a sharper failure mode, and most of what follows is about it. An anchor
// learned from a poll that did not succeed would be the MAC of whatever now holds the old
// address, written down as this device's own. That is worse than having no anchor: it does
// not merely fail to find the device, it points confidently at the wrong box. So the learn
// gate is tested from both sides, and the route that acts on an anchor re-checks it itself
// rather than trusting the page that called it.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');

const vendor  = require('../lib/mac-vendor');
const polling = require('../lib/modbus-polling');
const api     = require('../api.js');

const ANDIS_MAC  = 'b0:c7:87:ee:95:12';   // measured on the plant, OUI B0C787
const ANDIS_HOST = '10.160.13.72';

// ── the vendor table ────────────────────────────────────────────────────────

test('the MAC measured on the plant resolves to its manufacturer', () => {
  assert.strictEqual(vendor.vendorOf(ANDIS_MAC), 'Huawei');
  assert.strictEqual(vendor.ouiOf(ANDIS_MAC), 'B0C787');
});

test('a MAC is recognised whatever shape it arrives in', () => {
  // Homey documents getMAC as returning a string and nothing about its separator, so every
  // shape a neighbour table is known to print has to land on the same answer.
  for (const form of ['b0:c7:87:ee:95:12', 'B0-C7-87-EE-95-12', 'b0c787ee9512', 'B0:C7:87:ee:95:12']) {
    assert.strictEqual(vendor.normalizeMac(form), ANDIS_MAC, form);
    assert.strictEqual(vendor.vendorOf(form), 'Huawei', form);
  }
});

test('what is not a MAC is not an answer', () => {
  // Each of these has to read as "nobody answered", not as a device with an odd name.
  for (const junk of [null, undefined, 42, '', 'not a mac', 'b0:c7:87:ee:95', 'b0:c7:87:ee:95:12:34',
                      '00:00:00:00:00:00', 'zz:zz:zz:zz:zz:zz']) {
    assert.strictEqual(vendor.normalizeMac(junk), null, String(junk));
    assert.strictEqual(vendor.vendorOf(junk), null, String(junk));
    assert.strictEqual(vendor.describeMac(junk).mac, null, String(junk));
  }
});

test('a randomised MAC carries no manufacturer, even with a manufacturer prefix', () => {
  // Phones make their MAC up per network and set the locally-administered bit while doing
  // it. Reading a vendor out of such a prefix is inventing one — b2:c7:87 is b0:c7:87 with
  // that bit set, and Huawei has nothing to do with it.
  assert.strictEqual(vendor.isLocallyAdministered('b2:c7:87:ee:95:12'), true);
  assert.strictEqual(vendor.vendorOf('b2:c7:87:ee:95:12'), null);
  assert.strictEqual(vendor.describeMac('b2:c7:87:ee:95:12').local, true);

  assert.strictEqual(vendor.isLocallyAdministered(ANDIS_MAC), false);
});

test('Homey itself is recognised, and an unrelated manufacturer is not claimed', () => {
  assert.strictEqual(vendor.vendorOf('90:13:da:ab:4f:fe'), 'Athom');   // the Homey Pro
  assert.strictEqual(vendor.vendorOf('f4:92:bf:88:8b:88'), null);      // the router
});

test('the shipped prefix list is the whole IEEE registry, not a truncated copy', () => {
  // The list is generated. A generator that half-ran, or an editor that wrapped a very long
  // line, would leave a file that still parses and still says "Huawei" for the one address
  // anybody tests with — and silently stops recognising the rest.
  assert.strictEqual(vendor._VENDOR_COUNTS.Huawei, 2078);
  assert.strictEqual(vendor._VENDOR_COUNTS.Athom, 2);

  const src = fs.readFileSync(require.resolve('../lib/mac-vendor.js'), 'utf8');
  const blob = (src.match(/'[0-9A-F]{6,}'/g) || []).join('').replace(/'/g, '');
  assert.strictEqual(blob.length % 6, 0, 'a prefix line is not a whole number of prefixes');
  assert.ok(blob.includes('B0C787'), 'the measured prefix is missing from the source');
});

// ── the anchor: what a device learns, and when it refuses to ────────────────

function fakeDevice(opts = {}) {
  const {
    address = ANDIS_HOST, port = '502', modbusId = '1',
    store = {}, arp = async () => ANDIS_MAC,
  } = opts;

  const timers = [];
  const dev = {
    _failureCount:  0,
    _lastPollStart: 0,
    store: { ...store },
    logs: [],
    arpCalls: [],
    intervals: [],
    getSetting:    (k) => ({ address, port, modbus_id: modbusId })[k],
    getStoreValue: (k) => dev.store[k],
    setStoreValue: async (k, v) => { dev.store[k] = v; },
    log:   (...a) => dev.logs.push(a.join(' ')),
    error: (...a) => dev.logs.push('ERR ' + a.join(' ')),
    get pollDefaultS() { return 60; },
    get pollMinS()     { return 10; },
    // Every interval ever created, and the ids still running. A timer that was created and
    // never cleared is invisible in a count of creations — it only shows up as a gap
    // between the two.
    liveIds: new Set(),
    liveTimers() { return [...dev.liveIds]; },
    homey: {
      // Timers are held, never fired on their own, so a test decides whether the wait or
      // the answer wins instead of the clock deciding it.
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      setInterval: (fn, ms) => {
        const id = dev.intervals.push({ fn, ms });   // 1-based, and the id doubles as the index
        dev.liveIds.add(id);
        return id;
      },
      clearInterval: (id) => { dev.liveIds.delete(id); },
      arp: {
        getMAC: (ip) => { dev.arpCalls.push(ip); return arp(ip); },
      },
    },
    _timers: timers,
    fireTimers() { for (const t of timers.splice(0)) t.fn(); },
  };
  Object.assign(dev, polling);
  return dev;
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('a device learns its MAC from the address that just worked', async () => {
  const dev = fakeDevice();
  await dev._learnMac();

  assert.deepStrictEqual(dev.arpCalls, [ANDIS_HOST]);
  const anchor = dev.store[polling.MAC_ANCHOR_KEY];
  assert.strictEqual(anchor.mac, ANDIS_MAC);
  assert.strictEqual(anchor.address, ANDIS_HOST);
  assert.strictEqual(anchor.port, 502);
  assert.strictEqual(anchor.unitId, 1);
  assert.ok(anchor.at, 'the anchor records when it was learned');
});

test('an anchor already held for this address is not asked for again', async () => {
  const dev = fakeDevice({ store: { macAnchor: { mac: ANDIS_MAC, address: ANDIS_HOST } } });
  await dev._learnMac();
  assert.deepStrictEqual(dev.arpCalls, [], 'the neighbour table was asked for nothing new');
});

test('an anchor held for a different address is learned again', async () => {
  // The owner may have pointed the device at genuinely different hardware. Keeping the old
  // MAC would leave the anchor describing a box this device no longer talks to.
  const dev = fakeDevice({ store: { macAnchor: { mac: 'aa:bb:cc:dd:ee:ff', address: '10.0.0.9' } } });
  await dev._learnMac();
  assert.deepStrictEqual(dev.arpCalls, [ANDIS_HOST]);
  assert.strictEqual(dev.store[polling.MAC_ANCHOR_KEY].mac, ANDIS_MAC);
});

test('a device with no address asks nothing', async () => {
  const dev = fakeDevice({ address: '' });
  await dev._learnMac();
  assert.deepStrictEqual(dev.arpCalls, []);
  assert.strictEqual(dev.store[polling.MAC_ANCHOR_KEY], undefined);
});

test('a lookup that fails, hangs or answers nonsense leaves no anchor and no throw', async () => {
  // Three ways ManagerArp can disappoint. None of them may cost the poll its timer, and
  // none of them may leave something anchor-shaped behind.
  const rejects = fakeDevice({ arp: async () => { throw new Error('ENOTFOUND'); } });
  await rejects._learnMac();
  assert.strictEqual(rejects.store[polling.MAC_ANCHOR_KEY], undefined);

  const nonsense = fakeDevice({ arp: async () => 'no idea' });
  await nonsense._learnMac();
  assert.strictEqual(nonsense.store[polling.MAC_ANCHOR_KEY], undefined);

  const hangs = fakeDevice({ arp: () => new Promise(() => {}) });
  const pending = hangs._learnMac();
  await flush();
  assert.strictEqual(hangs._timers.length, 1, 'the wait is bounded');
  assert.strictEqual(hangs._timers[0].ms, polling.ARP_TIMEOUT_MS);
  hangs.fireTimers();
  await pending;
  assert.strictEqual(hangs.store[polling.MAC_ANCHOR_KEY], undefined);
});

test('a Homey without ARP support costs nothing', async () => {
  const dev = fakeDevice();
  delete dev.homey.arp;
  await dev._learnMac();
  assert.strictEqual(dev.store[polling.MAC_ANCHOR_KEY], undefined);
});

test('a store that refuses to be written does not take the poll down with it', async () => {
  const dev = fakeDevice();
  dev.setStoreValue = async () => { throw new Error('store full'); };
  await dev._learnMac();   // must not reject
  assert.ok(dev.logs.some((l) => l.includes('_learnMac failed')), 'and it says so');
});

// ── the gate: only a poll that ran and succeeded may teach the anchor ───────

async function tick(dev, fetchBehaviour) {
  dev._fetchAndUpdate = fetchBehaviour;
  await dev._startPolling();
  const pollTimer = dev.intervals[0];
  pollTimer.fn();
  await flush();
}

test('the anchor is learned after a poll that ran and succeeded', async () => {
  const dev = fakeDevice();
  await tick(dev, async () => { dev._lastPollStart = 1000; dev._failureCount = 0; });
  assert.strictEqual(dev.store[polling.MAC_ANCHOR_KEY].mac, ANDIS_MAC);
});

test('a poll that failed teaches nothing', async () => {
  // This is the mistake worth building the gate for. The address that no longer reaches the
  // inverter may very well reach something — the machine DHCP handed it to. Learning there
  // would write that machine's MAC down as the inverter's, and the anchor would then point
  // confidently at the wrong box forever.
  const dev = fakeDevice();
  await tick(dev, async () => { dev._lastPollStart = 1000; dev._failureCount = 3; });
  assert.deepStrictEqual(dev.arpCalls, []);
  assert.strictEqual(dev.store[polling.MAC_ANCHOR_KEY], undefined);
});

test('a tick where no poll ever started teaches nothing', async () => {
  // _fetchAndUpdate resolves on every path it has, including its two re-entry guards. A
  // plain .then() would treat "another poll is already running" as a successful reading.
  const dev = fakeDevice();
  dev._lastPollStart = 1000;
  await tick(dev, async () => { /* returns at the guard; _lastPollStart untouched */ });
  assert.deepStrictEqual(dev.arpCalls, []);
  assert.strictEqual(dev.store[polling.MAC_ANCHOR_KEY], undefined);
});

test('a poll that throws is still reported, and teaches nothing', async () => {
  const dev = fakeDevice();
  await tick(dev, async () => { dev._lastPollStart = 1000; throw new Error('socket closed'); });
  assert.deepStrictEqual(dev.arpCalls, []);
  assert.ok(dev.logs.some((l) => l.startsWith('ERR Poll failed')), 'the existing error path survives');
});

// ── the poll timer: starting twice must not leave one behind ────────────────

test('one device runs exactly one poll loop and one watchdog', async () => {
  const dev = fakeDevice();
  dev._fetchAndUpdate = async () => {};
  await dev._startPolling();
  assert.strictEqual(dev.liveTimers().length, 2, 'the poll timer and its watchdog');
  await dev._stopPolling();
  assert.deepStrictEqual(dev.liveTimers(), [], 'and both can be stopped again');
});

test('starting the poll twice leaves no timer nobody can reach', async () => {
  // `_stopPolling` can only clear what is in the field. A second start used to overwrite the
  // field, and the first timer then polled forever with its handle lost — the device asks
  // the inverter twice per interval for the rest of the app's life, on a bus that answers
  // one connection at a time.
  const dev = fakeDevice();
  dev._fetchAndUpdate = async () => {};
  await dev._startPolling();
  await dev._startPolling();
  assert.strictEqual(dev.liveTimers().length, 2, 'starting twice still runs one of each');
  await dev._stopPolling();
  assert.deepStrictEqual(dev.liveTimers(), [], 'nothing survives the stop');
});

test('two readers pausing and resuming around each other leave the device with one loop', async () => {
  // The real sequence, found reviewing 1.2.249: reader A pauses the device, reader B pauses
  // it while it is already paused and finds nothing to clear, then both resume. Since 1.2.245
  // four code paths pause and resume around a read, so this ordering is ordinary, not exotic.
  const dev = fakeDevice();
  dev._fetchAndUpdate = async () => {};
  await dev._startPolling();          // the device polls normally

  await dev._stopPolling();           // A pauses
  await dev._stopPolling();           // B pauses — nothing left to clear
  await dev._startPolling();          // A resumes
  await dev._startPolling();          // B resumes

  assert.strictEqual(dev.liveTimers().length, 2, 'an orphaned poll loop survived the overlap');
  await dev._stopPolling();
  assert.deepStrictEqual(dev.liveTimers(), [], 'and the device can still be shut down cleanly');
});

// ── the label and the moved-device report ───────────────────────────────────

function apiDevice(id, { address = ANDIS_HOST, anchor = null, name = id } = {}) {
  const dev = {
    settings: { address, port: '502', modbus_id: '1' },
    stopped: 0, started: 0, fetched: 0,
    getId: () => id,
    getName: () => name,
    getAvailable: () => true,
    getCapabilities: () => [],
    getCapabilityValue: () => null,
    getSettings: () => dev.settings,
    getSetting: (k) => dev.settings[k],
    getStoreValue: (k) => (k === 'macAnchor' ? anchor : undefined),
    setSettings: async (patch) => { Object.assign(dev.settings, patch); },
    _stopPolling:  async () => { dev.stopped += 1; },
    _startPolling: async () => { dev.started += 1; },
    _fetchAndUpdate: async () => { dev.fetched += 1; },
  };
  return dev;
}

function apiHomey(present, macs) {
  return {
    app: { log: () => {} },
    log: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    arp: { getMAC: async (ip) => macs[ip] ?? null },
    drivers: {
      getDriver(id) {
        if (!(id in present)) throw new Error('Invalid Driver');
        return { getDevices: () => present[id] };
      },
    },
  };
}

test('found hosts come back with a manufacturer where one is known', async () => {
  const homey = apiHomey({ sun2000_modbus: [] }, {
    [ANDIS_HOST]: ANDIS_MAC,
    '10.160.12.100': 'b0:81:84:ec:d8:60',   // some other maker
    '10.160.12.7':   null,                  // nothing came back
  });
  const res = await api.scanMacs({ homey, body: { hosts: [ANDIS_HOST, '10.160.12.100', '10.160.12.7'] } });

  assert.strictEqual(res.hosts[ANDIS_HOST].vendor, 'Huawei');
  assert.strictEqual(res.hosts[ANDIS_HOST].mac, ANDIS_MAC);
  assert.strictEqual(res.hosts['10.160.12.100'].vendor, null, 'an unknown prefix is not given a name');
  assert.strictEqual(res.hosts['10.160.12.100'].mac, 'b0:81:84:ec:d8:60', 'but its MAC is still shown');
  assert.strictEqual(res.hosts['10.160.12.7'].mac, null);
  assert.strictEqual(res.resolved, 2);
});

test('malformed and duplicate hosts never reach the neighbour table', async () => {
  const asked = [];
  const homey = apiHomey({}, {});
  homey.arp.getMAC = async (ip) => { asked.push(ip); return null; };

  await api.scanMacs({ homey, body: { hosts: [ANDIS_HOST, ANDIS_HOST, '999.1.1.1', 'localhost', '', null, 7] } });
  assert.deepStrictEqual(asked, [ANDIS_HOST]);

  const bad = await api.scanMacs({ homey, body: {} });
  assert.ok(bad.error, 'a call with no hosts is refused rather than guessed at');
});

test('one MAC answering for several addresses names nobody and moves nobody', async () => {
  // Proxy ARP, or a netmask set wider than the segment really is: the router answers on
  // behalf of addresses it forwards for. Every such address then carries the router's MAC,
  // which identifies nothing — and would otherwise match every anchor at once.
  const anchor = { mac: ANDIS_MAC, address: '10.160.12.50' };
  const homey = apiHomey(
    { sun2000_modbus: [apiDevice('d-1', { address: '10.160.12.50', anchor })] },
    { '10.160.13.72': ANDIS_MAC, '10.160.13.73': ANDIS_MAC },
  );
  const res = await api.scanMacs({ homey, body: { hosts: ['10.160.13.72', '10.160.13.73'] } });

  assert.strictEqual(res.hosts['10.160.13.72'].ambiguous, true);
  assert.strictEqual(res.hosts['10.160.13.73'].ambiguous, true);
  assert.deepStrictEqual(res.moved, [], 'an address that identifies nothing cannot say a device moved');
});

test('a device whose anchor turns up elsewhere is reported as moved', async () => {
  const anchor = { mac: ANDIS_MAC, address: '10.160.12.50' };
  const homey = apiHomey(
    { sun2000_modbus: [apiDevice('d-1', { address: '10.160.12.50', anchor, name: 'Wechselrichter' })] },
    { [ANDIS_HOST]: ANDIS_MAC },
  );
  const res = await api.scanMacs({ homey, body: { hosts: [ANDIS_HOST] } });

  assert.strictEqual(res.moved.length, 1);
  assert.deepStrictEqual(res.moved[0], {
    driverId: 'sun2000_modbus', deviceId: 'd-1', name: 'Wechselrichter',
    current: '10.160.12.50', foundAt: ANDIS_HOST, mac: ANDIS_MAC,
  });
});

test('a device found exactly where its settings say is not reported as moved', async () => {
  const anchor = { mac: ANDIS_MAC, address: ANDIS_HOST };
  const homey = apiHomey(
    { sun2000_modbus: [apiDevice('d-1', { address: ANDIS_HOST, anchor })] },
    { [ANDIS_HOST]: ANDIS_MAC },
  );
  const res = await api.scanMacs({ homey, body: { hosts: [ANDIS_HOST] } });
  assert.deepStrictEqual(res.moved, [], 'nothing happened, so nothing is offered');
});

test('a device that has never learned an anchor is never reported as moved', async () => {
  const homey = apiHomey(
    { sun2000_modbus: [apiDevice('d-1', { address: '10.160.12.50', anchor: null })] },
    { [ANDIS_HOST]: ANDIS_MAC },
  );
  const res = await api.scanMacs({ homey, body: { hosts: [ANDIS_HOST] } });
  assert.deepStrictEqual(res.moved, []);
});

// ── taking the address over ─────────────────────────────────────────────────

test('adopting writes the address and restarts the poll itself', async () => {
  // Homey does not call onSettings for a programmatic write, so the restart the eight
  // drivers do there has to happen here. Without it the device keeps its old timer and
  // stays grey for up to a full poll interval after being repaired.
  const anchor = { mac: ANDIS_MAC, address: '10.160.12.50' };
  const dev = apiDevice('d-1', { address: '10.160.12.50', anchor });
  const homey = apiHomey({ sun2000_modbus: [dev] }, { [ANDIS_HOST]: ANDIS_MAC });

  const res = await api.adoptAddress({
    homey, body: { address: ANDIS_HOST, devices: [{ driverId: 'sun2000_modbus', deviceId: 'd-1' }] },
  });

  assert.strictEqual(res.results[0].ok, true);
  assert.strictEqual(dev.settings.address, ANDIS_HOST);
  assert.strictEqual(dev.settings.port, '502', 'the port is left alone — DHCP does not move ports');
  assert.strictEqual(dev.settings.modbus_id, '1', 'and neither is the unit ID');
  assert.strictEqual(dev.stopped, 1);
  assert.strictEqual(dev.started, 1);
  assert.strictEqual(dev.fetched, 1);
});

test('adopting refuses when the MAC at the target is not this device', async () => {
  // The route re-reads the MAC rather than trusting the page. A button that writes whatever
  // address it is handed is one interface mistake away from pointing a battery at somebody
  // else's inverter.
  const anchor = { mac: ANDIS_MAC, address: '10.160.12.50' };
  const dev = apiDevice('d-1', { address: '10.160.12.50', anchor });
  const homey = apiHomey({ sun2000_modbus: [dev] }, { '10.160.13.99': 'aa:bb:cc:dd:ee:ff' });

  const res = await api.adoptAddress({
    homey, body: { address: '10.160.13.99', devices: [{ driverId: 'sun2000_modbus', deviceId: 'd-1' }] },
  });

  assert.strictEqual(res.results[0].ok, false);
  assert.strictEqual(res.results[0].reason, 'anchor-mismatch');
  assert.strictEqual(dev.settings.address, '10.160.12.50', 'the setting was left untouched');
  assert.strictEqual(dev.started, 0);
});

test('adopting refuses an address nothing answered for', async () => {
  const dev = apiDevice('d-1', { anchor: { mac: ANDIS_MAC, address: ANDIS_HOST } });
  const homey = apiHomey({ sun2000_modbus: [dev] }, {});
  const res = await api.adoptAddress({
    homey, body: { address: '10.160.13.99', devices: [{ driverId: 'sun2000_modbus', deviceId: 'd-1' }] },
  });
  assert.ok(res.error, 'no MAC, no move');
  assert.strictEqual(dev.started, 0);
});

test('adopting refuses a malformed request rather than interpreting it', async () => {
  // Refusing is not enough — it has to refuse for the right reason. A route that lets a
  // malformed address through and then reports "nothing answered" looks identical from the
  // outside while having already handed the string to the network layer. So the test watches
  // what reached the neighbour table, not only what came back.
  const asked = [];
  const homey = apiHomey({}, {});
  homey.arp.getMAC = async (ip) => { asked.push(ip); return null; };

  for (const body of [{}, { address: 'nope', devices: [{}] }, { address: ANDIS_HOST },
                      { address: ANDIS_HOST, devices: [] }, { address: '999.1.1.1', devices: [{}] },
                      { address: '10.0.0.1; rm -rf /', devices: [{}] }]) {
    const res = await api.adoptAddress({ homey, body });
    assert.ok(res.error, JSON.stringify(body));
  }
  assert.deepStrictEqual(asked, [], 'no malformed address was ever looked up');
});

test('adopting an address a device already has changes nothing', async () => {
  const dev = apiDevice('d-1', { address: ANDIS_HOST, anchor: { mac: ANDIS_MAC, address: ANDIS_HOST } });
  const homey = apiHomey({ sun2000_modbus: [dev] }, { [ANDIS_HOST]: ANDIS_MAC });
  const res = await api.adoptAddress({
    homey, body: { address: ANDIS_HOST, devices: [{ driverId: 'sun2000_modbus', deviceId: 'd-1' }] },
  });
  assert.strictEqual(res.results[0].reason, 'unchanged');
  assert.strictEqual(dev.started, 0, 'and the poll is not restarted for nothing');
});

test('the device list carries the anchor so the page can tell what is known', async () => {
  const anchor = { mac: ANDIS_MAC, address: ANDIS_HOST, port: 502, unitId: 1, at: '2026-09-20T10:00:00.000Z' };
  const homey = apiHomey({ sun2000_modbus: [apiDevice('d-1', { anchor })] }, {});
  const res = await api.getDebugDevices({ homey });
  assert.deepStrictEqual(res.devices[0].macAnchor, anchor);

  const none = apiHomey({ sun2000_modbus: [apiDevice('d-1', { anchor: null })] }, {});
  const res2 = await api.getDebugDevices({ homey: none });
  assert.strictEqual(res2.devices[0].macAnchor, null, 'not learned yet is null, never an empty object');
});

// ── the settings page ───────────────────────────────────────────────────────

test('the settings page asks for the labels after rendering, never during the scan', () => {
  // The scan spends four to five of the twelve seconds the page allows. A manufacturer name
  // is not worth turning a scan that worked into a scan that reported failure.
  const html = fs.readFileSync(require.resolve('../settings/index.html'), 'utf8');
  const scan = html.slice(html.indexOf('function startPortScan'), html.indexOf('const DEFAULT_UNIT_IDS'));
  assert.ok(!scan.includes('/scan/macs'), 'the scan call itself must not wait for MAC lookups');

  // Looked for as a live statement, not as a substring: a commented-out call still contains
  // the text, so `includes` alone would keep passing after somebody disabled the feature.
  const render = html.slice(html.indexOf('function renderPortScanResults'), html.indexOf('function macCellHtml'));
  const live = render.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('annotateMacs(hosts)') && !l.startsWith('//') && !l.startsWith('*'));
  assert.strictEqual(live.length, 1, 'the labels are fetched once the rows are on screen');
});

test('every string the new interface shows exists in all three languages', () => {
  // A missing translation is not a blank space: Homey prints the raw dotted path, so the
  // one reader it fails is the one reading in the language nobody checked.
  const html = fs.readFileSync(require.resolve('../settings/index.html'), 'utf8');
  const region = html.slice(html.indexOf('function macCellHtml'), html.indexOf('function startPortScan'));
  assert.ok(region.length > 500, 'the new interface block was not found where it was expected');

  const used = new Set();
  for (const m of region.matchAll(/_H\.__\('([^']+)'\)/g)) used.add(m[1]);

  const NEW_KEYS = ['macAmbiguous', 'macAmbiguousHint', 'movedIntro',
                    'adoptAddress', 'adopting', 'adopted', 'adoptFailed'];
  for (const key of NEW_KEYS) {
    assert.ok(used.has(`settings.tester.${key}`), `the interface never shows settings.tester.${key}`);
  }

  for (const lang of ['de', 'en', 'nl']) {
    const dict = JSON.parse(fs.readFileSync(require.resolve(`../locales/${lang}.json`), 'utf8'));
    for (const key of used) {
      const value = key.split('.').reduce((o, k) => (o == null ? o : o[k]), dict);
      assert.strictEqual(typeof value, 'string', `${lang}.json is missing ${key}`);
    }
  }
});

test('a row carrying a MAC can break instead of widening the page', () => {
  // Found in the field on the first look at 1.2.249: the manufacturer label may not be
  // broken mid-address, so on a panel too narrow for it the label sets the row's minimum
  // width — and the whole settings page grew a sideways scrollbar. Every row that holds an
  // unbreakable label has to be allowed to wrap.
  const html = fs.readFileSync(require.resolve('../settings/index.html'), 'utf8');
  for (const selector of ['.host-row', '.moved-row']) {
    const rule = html.slice(html.indexOf(`    ${selector} {`));
    const body = rule.slice(0, rule.indexOf('}'));
    assert.ok(body.includes('display: flex'), `${selector} is no longer a flex row — re-check this test`);
    assert.ok(body.includes('flex-wrap: wrap'), `${selector} cannot wrap, so a long label widens the page`);
  }

  // The other half of the same decision: the ROW gives way, the ADDRESS never does.
  // "b0:c7:87:ee:" on one line and "95:12" on the next is not a MAC anybody can read, and
  // letting it wrap would have been the lazy way to stop the page from widening.
  const macRule = html.slice(html.indexOf('    .host-row .host-mac {'));
  const macBody = macRule.slice(0, macRule.indexOf('}'));
  assert.ok(macBody.includes('white-space: nowrap'), 'the MAC may be pushed to its own line, never broken across two');
  assert.ok(macBody.includes('max-width: 100%'), 'and it stays inside the row even on a panel narrower than itself');
});

test('the two new routes are declared in the manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(require.resolve('../app.json'), 'utf8'));
  assert.deepStrictEqual(manifest.api.scanMacs, { method: 'POST', path: '/scan/macs' });
  assert.deepStrictEqual(manifest.api.adoptAddress, { method: 'POST', path: '/scan/adopt' });
  assert.deepStrictEqual(manifest.permissions, [], 'ARP needs no permission — none was added');
});
