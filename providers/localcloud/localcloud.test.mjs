import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVAL_TAG, createCloud } from './server.mjs';

async function start() {
  const cloud = createCloud({ readToken: 'r-token', writeToken: 'w-token' });
  await new Promise((r) => cloud.server.listen(0, r));
  const base = `http://127.0.0.1:${cloud.server.address().port}`;
  const call = async (method, p, token, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, ...headers }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { cloud, call, close: () => cloud.server.close() };
}

test('read token can read billing and resources but never mutate', async () => {
  const { call, close } = await start();
  assert.ok((await call('GET', '/v1/billing/daily', 'r-token')).body.items.length > 300);
  assert.equal((await call('GET', '/v1/billing/daily', 'bad')).status, 401);
  assert.equal((await call('DELETE', '/v1/resources/vol-0orphan01', 'r-token')).status, 403);
  assert.equal((await call('POST', '/v1/resources/vol-0orphan01/tags', 'r-token', { [APPROVAL_TAG]: 'true' })).status, 403);
  close();
});

test('write token is scoped: untagged and attached resources cannot be deleted, other tags cannot be written', async () => {
  const { call, close, cloud } = await start();
  assert.equal((await call('DELETE', '/v1/resources/vol-0orphan01', 'w-token')).status, 403, 'not tagged');
  assert.equal((await call('POST', '/v1/resources/database-main/tags', 'w-token', { owner: 'me' })).status, 403, 'wrong tag');
  await call('POST', '/v1/resources/database-main/tags', 'w-token', { [APPROVAL_TAG]: 'true' });
  assert.equal((await call('DELETE', '/v1/resources/database-main', 'w-token')).status, 409, 'attached');
  assert.ok(cloud.resources.has('database-main'));
  close();
});

test('approved orphan is deleted once; idempotency key replays', async () => {
  const { call, close, cloud } = await start();
  await call('POST', '/v1/resources/vol-0orphan01/tags', 'w-token', { [APPROVAL_TAG]: 'true' }, { 'idempotency-key': 'k:tag' });
  const first = await call('DELETE', '/v1/resources/vol-0orphan01', 'w-token', undefined, { 'idempotency-key': 'k:del' });
  const again = await call('DELETE', '/v1/resources/vol-0orphan01', 'w-token', undefined, { 'idempotency-key': 'k:del' });
  assert.equal(first.status, 200); assert.equal(again.body.replayed, true);
  assert.equal(cloud.resources.has('vol-0orphan01'), false);
  close();
});
