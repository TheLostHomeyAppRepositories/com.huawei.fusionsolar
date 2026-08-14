'use strict';

// Behaviour of the shared "_Huawei EMS" flow-folder lookup in api.js.
//
// The helper is module-private, so it is driven through the heat-pump setup route, which
// is the shortest path that reaches it. That is deliberate rather than a compromise: the
// risk of collapsing seven inlined copies into one call was never the lookup itself but
// whether its result still lands in the flow payload at every site, and only going
// through a route proves that.
//
// lib/homey-local-api is stubbed in the require cache before api.js is loaded, so no
// HTTP happens. `node --test` runs each test file in its own process, so the stub cannot
// leak into the other suites.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const Module = require('module');

// ── Stub the local-API client ────────────────────────────────────────────────
let calls;
const clientPath = require.resolve('../lib/homey-local-api');
class FakeLocalApi {
  constructor() { Object.assign(this, calls.impl); }
}
require.cache[clientPath] = new Module(clientPath, null);
require.cache[clientPath].filename = clientPath;
require.cache[clientPath].loaded = true;
require.cache[clientPath].exports = FakeLocalApi;

const api = require('../api.js');

function fakeHomey() {
  return {
    drivers: {
      getDriver: () => ({
        getDevices: () => [{
          getSetting: (k) => (k === 'homey_api_key' ? 'key-1' : undefined),
          getData: () => ({ id: 'ems-1' }),
        }],
      }),
    },
  };
}

// Records what the route asked the local API to do, and lets each test decide how the
// folder endpoints behave.
function scenario({ folders = {}, createFolder } = {}) {
  const created = [];
  const folderCreates = [];
  calls = {
    created, folderCreates,
    impl: {
      async getFlowFolders() {
        if (folders instanceof Error) throw folders;
        return folders;
      },
      async createFlowFolder(f) {
        folderCreates.push(f);
        if (createFolder instanceof Error) throw createFolder;
        return createFolder === undefined ? { id: 'new-folder' } : createFolder;
      },
      async getFlows() { return {}; },
      async deleteFlow() {},
      async createFlow(payload) { created.push(payload); return { id: 'flow-' + created.length }; },
      async getDevices() { return {}; },
    },
  };
  return calls;
}

const BODY = {
  emsDeviceId: 'ems-1', deviceId: 'hp-1', deviceName: 'Heat pump',
  startCardId: 'start_card', startCardUri: 'homey:app:x',
  stopCardId: 'stop_card',   stopCardUri: 'homey:app:x',
};

test('an existing folder is reused, and its id lands on every created flow', async () => {
  const s = scenario({ folders: { f1: { id: 'existing-1', name: '_Huawei EMS' } } });
  const res = await api.postEmsHeatPumpSetupFlows({ homey: fakeHomey(), body: BODY });
  assert.strictEqual(res.folderId, 'existing-1');
  assert.deepStrictEqual(s.folderCreates, [], 'must not create a folder that already exists');
  assert.strictEqual(s.created.length, 2);
  for (const flow of s.created) assert.strictEqual(flow.folder, 'existing-1');
});

test('a missing folder is created once, under the expected name', async () => {
  const s = scenario({ folders: { other: { id: 'x', name: 'Something else' } } });
  const res = await api.postEmsHeatPumpSetupFlows({ homey: fakeHomey(), body: BODY });
  assert.strictEqual(res.folderId, 'new-folder');
  assert.deepStrictEqual(s.folderCreates, [{ name: '_Huawei EMS' }]);
  for (const flow of s.created) assert.strictEqual(flow.folder, 'new-folder');
});

test('a Homey that cannot list folders still creates the flows, at the top level', async () => {
  // The folder is a nicety; losing it must not cost the user their flows.
  const s = scenario({ folders: new Error('Missing Scopes') });
  const res = await api.postEmsHeatPumpSetupFlows({ homey: fakeHomey(), body: BODY });
  assert.strictEqual(res.folderId, null);
  assert.strictEqual(s.created.length, 2, 'flows must still be created');
  for (const flow of s.created) assert.strictEqual(flow.folder, null);
});

test('a Homey that refuses folder creation behaves the same way', async () => {
  const s = scenario({ folders: {}, createFolder: new Error('403') });
  const res = await api.postEmsHeatPumpSetupFlows({ homey: fakeHomey(), body: BODY });
  assert.strictEqual(res.folderId, null);
  assert.strictEqual(s.created.length, 2);
});

test('a folder create that answers without an id resolves to null, not undefined', async () => {
  // `folder: undefined` would be dropped from the JSON payload entirely, which reads to
  // Homey as "field omitted" rather than "no folder".
  const s = scenario({ folders: {}, createFolder: {} });
  const res = await api.postEmsHeatPumpSetupFlows({ homey: fakeHomey(), body: BODY });
  assert.strictEqual(res.folderId, null);
  for (const flow of s.created) assert.strictEqual(flow.folder, null);
});
