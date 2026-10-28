import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CredentialFacade } from '../src/security/credentials.js';
import { ImageConnectionCredentialStore } from '../src/security/image-credentials.js';

const secret = `arbitrary-provider-detail-${randomUUID()}`;
const supplied = `submitted-value-${randomUUID()}`;
const ref = 'OPENAI_API_KEY';
const id = 'img_test_12345678';

function provider(failingOperation, { failDescribeAfterMutation = false } = {}) {
  let mutated = false;
  const service = {};
  for (const operation of ['describe', 'set', 'unset', 'resolve']) {
    service[operation] = async () => {
      if (operation === failingOperation && (!failDescribeAfterMutation || mutated)) {
        throw new Error(`provider ${operation}: ${secret}`);
      }
      if (operation === 'set' || operation === 'unset') mutated = true;
      return operation === 'describe'
        ? { configured: true, writable: true, source: 'managed' }
        : operation === 'resolve' ? { value: supplied, source: 'managed' } : undefined;
    };
  }
  return service;
}

async function assertSafeFailure(action, message) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, message);
    assert.doesNotMatch(error.message, /arbitrary-provider-detail|submitted-value/);
    assert.doesNotMatch(error.stack ?? '', /arbitrary-provider-detail|submitted-value/);
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!JSON.stringify(error).includes(supplied));
    return true;
  });
}

test('credential facade hides arbitrary provider errors from every operation and follow-up describe', async () => {
  for (const [operation, action] of [
    ['describe', facade => facade.describe(ref)],
    ['describe', facade => facade.describeAll()],
    ['set', facade => facade.set(ref, supplied)],
    ['unset', facade => facade.unset(ref)],
  ]) await assertSafeFailure(() => action(new CredentialFacade(provider(operation))), '凭据服务操作失败');

  await assertSafeFailure(() => new CredentialFacade(provider('describe', { failDescribeAfterMutation: true })).set(ref, supplied), '凭据服务操作失败');
  await assertSafeFailure(() => new CredentialFacade(provider('describe', { failDescribeAfterMutation: true })).unset(ref), '凭据服务操作失败');
});

test('image credential store hides arbitrary provider errors from every operation and follow-up describe', async () => {
  for (const [operation, action] of [
    ['describe', store => store.describe(id)],
    ['set', store => store.set(id, supplied)],
    ['unset', store => store.clear(id)],
    ['resolve', store => store.resolve(id)],
  ]) await assertSafeFailure(() => action(new ImageConnectionCredentialStore(provider(operation))), '生图凭据服务操作失败');

  await assertSafeFailure(() => new ImageConnectionCredentialStore(provider('describe', { failDescribeAfterMutation: true })).set(id, supplied), '生图凭据服务操作失败');
  await assertSafeFailure(() => new ImageConnectionCredentialStore(provider('describe', { failDescribeAfterMutation: true })).clear(id), '生图凭据服务操作失败');
});
