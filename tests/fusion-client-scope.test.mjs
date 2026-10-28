import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const bundle = path.resolve(import.meta.dirname, '../plugins/dsh-model-fusion/lib/client.js');

function loadClient() {
  let plugin;
  const context = vm.createContext({
    window: { __ModuleLoader__: { load(entry) { plugin = entry.factory(() => ({})); } } },
  });
  vm.runInContext(fs.readFileSync(bundle, 'utf8'), context, { filename: bundle });
  return plugin;
}

test('Fusion client registers settings and dock with the model directory service dependencies', () => {
  const plugin = loadClient();
  const required = ['slots', 'sessions', 'remote', 'remote.session'];
  for (const service of required) assert.ok(plugin.inject.includes(service), `missing root dependency ${service}`);

  const registrations = [];
  let dock;
  const slots = {
    inject(name, callback) { callback(); },
    register(options, component) {
      registrations.push({ options, component });
      if (options.name === 'conversation.input.dock') dock = options;
    },
  };
  const sessions = { scope: sessionId => ({ id: sessionId }) };
  const remote = { session: { modelCatalog: () => undefined } };
  const directory = { store: { ready: true }, load: async () => undefined };
  const ctx = {
    slots,
    inject(deps, callback) {
      if (deps.includes('locale')) return;
      const permitted = new Set(['slots', ...deps]);
      const scoped = new Proxy({ slots, sessions, remote }, {
        get(target, property) {
          if (property === 'modelDirectories') {
            assert.ok(permitted.has('modelDirectories'), 'modelDirectories is outside the injected scope');
            return {
              directoryFor(sessionId) {
                assert.equal(scoped.sessions.scope(sessionId).id, sessionId);
                assert.equal(scoped.remote.session, remote.session);
                assert.ok(permitted.has('remote.session'), 'remote.session is outside the injected scope');
                return directory;
              },
            };
          }
          assert.ok(permitted.has(property), `${String(property)} is outside the injected scope`);
          return target[property];
        },
      });
      callback(scoped);
    },
  };

  plugin.apply(ctx);
  assert.ok(registrations.some(({ options }) => options.name === 'settings.section' && options.id === 'fusion'));
  assert.ok(dock, 'Fusion configuration dock was not registered');
  const contribution = dock.inject('session-1');
  assert.equal(contribution.directory, directory.store);
  assert.equal(contribution.sessionId, 'session-1');
});
