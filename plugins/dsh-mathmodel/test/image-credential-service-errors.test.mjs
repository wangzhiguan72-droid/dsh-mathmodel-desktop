import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ImageConnectionService } from '../src/image/connections.js';
import { migrateFromV1, validateImageConnections } from '../src/security/image-connections.js';

const secret = `unknown-provider-secret-${randomUUID()}`;
const savedKey = `saved-key-${randomUUID()}`;
const stamp = '2026-10-16T00:00:00.000Z';

function fixture({ failing, fetchImpl } = {}) {
  let state = migrateFromV1({ providerOrder: ['openai', 'dashscope', 'gemini', 'custom'] }, {
    now: () => stamp, isConfigured: () => true,
  });
  const connection = state.connections.find(item => item.credentialRef === 'OPENAI_API_KEY');
  const provider = Object.fromEntries(['describe', 'resolve', 'set', 'unset'].map(operation => [operation, async () => {
    if (operation === failing) {
      const error = new Error(`credential provider ${operation}: ${secret}`);
      error.code = 'provider_error';
      throw error;
    }
    if (operation === 'describe') return { configured: true, writable: true, source: 'managed' };
    if (operation === 'resolve') return { value: savedKey, source: 'managed' };
  }]));
  const service = new ImageConnectionService({
    settings: { get: () => state, replace: async next => { state = next; } },
    hasV2UserSection: () => true,
    credentialProvider: provider,
    credentialStore: { describe: async () => ({ configured: false, writable: true }) },
    fetchImpl: fetchImpl ?? (async () => ({ ok: true, json: async () => ({ data: [] }) })),
  });
  return { service, connection };
}

function grokFixture(fetchImpl) {
  const base = fixture();
  const grok = {
    id: 'img_grok_fixture', name: 'Grok fixture', template: 'grok-subscription',
    adapter: 'grok-images', model: 'grok-imagine-image', baseUrl: 'https://api.x.ai/v1',
    credentialRef: 'MATHMODEL_IMAGE_GROK_FIXTURE', createdAt: stamp, updatedAt: stamp,
  };
  const state = migrateFromV1({}, { now: () => stamp });
  const service = new ImageConnectionService({
    settings: { get: () => ({ ...state, connections: [...state.connections, grok] }) },
    hasV2UserSection: () => true,
    credentialProvider: base.service.credentialProvider,
    subscriptionSessions: { resolve: async () => ({ accessToken: savedKey }) },
    fetchImpl,
  });
  return { service, grok };
}

async function assertNoLeak(action, expectedMessage) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof Error);
    if (expectedMessage) assert.equal(error.message, expectedMessage);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes(savedKey), false);
    assert.equal((error.stack ?? '').includes(secret), false);
    assert.equal((error.stack ?? '').includes(savedKey), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(JSON.stringify(error).includes(savedKey), false);
    return true;
  });
}

test('legacy image credential provider errors are safe on read, write, clear, and remove', async () => {
  for (const [failing, action] of [
    ['describe', ({ service, connection }) => service.describeCredential(connection)],
    ['resolve', ({ service, connection }) => service.resolveCredential(connection)],
    ['set', ({ service, connection }) => service.setCredential(connection, savedKey)],
    ['unset', ({ service, connection }) => service.clearCredential(connection.id)],
    ['unset', ({ service, connection }) => service.remove(connection.id, { clearCredential: true })],
  ]) await assertNoLeak(() => action(fixture({ failing })));
});

test('Grok model discovery contains subscription token in neither errors nor untrusted HTTP status', async () => {
  const network = grokFixture(async () => {
    const error = new Error(`subscription ${savedKey}; ${secret}`);
    error.code = 'subscription_transport_error';
    throw error;
  });
  await assertNoLeak(() => network.service.discoverModels(network.grok.id), '模型列表请求失败');

  const badStatus = grokFixture(async () => ({ ok: false, status: `401-${savedKey}-${secret}` }));
  await assertNoLeak(() => badStatus.service.discoverModels(badStatus.grok.id));

  const invalidJson = grokFixture(async () => ({ ok: true, json: async () => {
    const error = new Error(`json ${savedKey}; ${secret}`);
    error.code = 'bad_json';
    throw error;
  } }));
  await assertNoLeak(() => invalidJson.service.discoverModels(invalidJson.grok.id), '模型列表请求失败');

  let bearer;
  const working = grokFixture(async (_url, init) => {
    bearer = init.headers.authorization;
    return { ok: true, json: async () => ({ data: [{ id: 'chat-model' }, { id: 'grok-imagine-image-2' }] }) };
  });
  assert.deepEqual((await working.service.discoverModels(working.grok.id)).models, [{ id: 'grok-imagine-image-2' }]);
  assert.equal(bearer, `Bearer ${savedKey}`);

  const rejected = grokFixture(async () => ({ ok: false, status: 401 }));
  await assert.rejects(() => rejected.service.discoverModels(rejected.grok.id), error => error.code === 'models_endpoint_rejected');
});

test('failed v1 settings read aborts migration without replacing existing settings', async () => {
  const original = { customModel: 'user model', customBaseUrl: 'https://gateway.example/v1' };
  let current = original;
  let replaces = 0;
  const service = new ImageConnectionService({
    settings: { get: () => current, replace: async next => { replaces += 1; current = next; } },
    legacySettings: { get: () => { throw new Error(`legacy settings ${secret}`); } },
    hasV2UserSection: () => false,
  });
  await assertNoLeak(() => service.ensureMigrated(), '旧生图配置读取失败');
  assert.equal(replaces, 0);
  assert.strictEqual(current, original);
});

test('legacy credential clear failure keeps connection available for retry', async () => {
  const { service, connection } = fixture();
  let attempts = 0;
  service.credentialProvider.unset = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error(`unset ${secret}`);
  };
  await assertNoLeak(() => service.remove(connection.id, { clearCredential: true }), '生图凭据服务操作失败');
  assert.ok(service.value().connections.some(item => item.id === connection.id));
  await service.remove(connection.id, { clearCredential: true });
  assert.equal(attempts, 2);
  assert.equal(service.value().connections.some(item => item.id === connection.id), false);
});

test('dynamic credential clear failure keeps connection available for retry', async () => {
  const initial = migrateFromV1({}, { now: () => stamp });
  const dynamic = {
    id: 'img_dynamic_fixture', name: 'Dynamic fixture', template: 'openai',
    adapter: 'openai-images', model: 'gpt-image-1', baseUrl: 'https://api.openai.com/v1',
    credentialRef: 'MATHMODEL_IMAGE_DYNAMIC_FIXTURE', createdAt: stamp, updatedAt: stamp,
  };
  let state = validateImageConnections({ ...initial, connections: [...initial.connections, dynamic] });
  let attempts = 0;
  const service = new ImageConnectionService({
    settings: { get: () => state, replace: async next => { state = next; } },
    hasV2UserSection: () => true,
    credentialProvider: { describe: async () => ({ configured: false, writable: true }) },
    credentialStore: {
      describe: async () => ({ configured: true, writable: true }),
      clear: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error(`dynamic clear ${secret}`);
      },
    },
  });
  await assertNoLeak(() => service.remove(dynamic.id, { clearCredential: true }));
  assert.ok(service.value().connections.some(item => item.id === dynamic.id));
  await service.remove(dynamic.id, { clearCredential: true });
  assert.equal(attempts, 2);
  assert.equal(service.value().connections.some(item => item.id === dynamic.id), false);
});

test('settings write failure retains the reference after a successful credential clear', async () => {
  const initial = migrateFromV1({}, { now: () => stamp });
  const connection = initial.connections.find(item => item.credentialRef === 'OPENAI_API_KEY');
  let state = initial;
  let writes = 0;
  let clears = 0;
  const service = new ImageConnectionService({
    settings: {
      get: () => state,
      replace: async next => {
        writes += 1;
        if (writes === 1) throw new Error(`settings ${secret}`);
        state = next;
      },
    },
    hasV2UserSection: () => true,
    credentialProvider: {
      describe: async () => ({ configured: false, writable: true }),
      unset: async () => { clears += 1; },
    },
  });
  await assertNoLeak(() => service.remove(connection.id, { clearCredential: true }), '生图连接设置保存失败');
  assert.equal(clears, 1);
  assert.equal(service.value().connections.find(item => item.id === connection.id)?.credentialRef, 'OPENAI_API_KEY');
  await service.remove(connection.id, { clearCredential: true });
  assert.equal(writes, 2);
  assert.equal(service.value().connections.some(item => item.id === connection.id), false);
});

test('model discovery never passes through coded provider errors, while trusted business codes survive', async () => {
  const leak = fixture({ fetchImpl: async () => {
    const error = new Error(`Bearer ${savedKey}; ${secret}`);
    error.code = 'provider_http_error';
    throw error;
  } });
  await assertNoLeak(() => leak.service.discoverModels(leak.connection.id));

  const rejected = fixture({ fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(() => rejected.service.discoverModels(rejected.connection.id), error => {
    assert.equal(error.code, 'models_endpoint_rejected');
    assert.match(error.message, /HTTP 401/);
    return true;
  });

  const malformed = fixture({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: null }) }) });
  await assert.rejects(() => malformed.service.discoverModels(malformed.connection.id), error => {
    assert.equal(error.code, 'invalid_models_response');
    return true;
  });
});
