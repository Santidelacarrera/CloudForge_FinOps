// Integration tests against real PostgreSQL and Redis. Skipped unless CLOUDFORGE_PG_URL / REDIS_URL are set.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import pg from 'pg';
import IORedis from 'ioredis';
import { Engine } from '../src/index.js';
import { PgStore } from '../src/pg-store.js';
import { ExecutionQueue } from '../src/queue.js';

const PG = process.env.CLOUDFORGE_PG_URL;
const REDIS = process.env.REDIS_URL;
const wf = JSON.parse(readFileSync(new URL('../../examples/workflows/rightsize-with-approval.json', import.meta.url)));
const requester = { id: 'u-dev', orgId: 'org-a', roles: [] };
const approver = { id: 'u-fin', orgId: 'org-a', roles: ['approver'] };
const uid = () => Math.random().toString(36).slice(2, 8);

function mkEngine(store, applied) {
  return new Engine({ store, sleep: async () => {}, connectors: {
    simulators: { rightsize: async () => ({ action: 'rightsize', estimatedMonthlySavingsUsd: 310 }) },
    cloud: { apply: async (plan, { idempotencyKey }) => { applied.push(idempotencyKey); return { ok: true }; } },
    notify: async () => ({ ok: true }) } });
}

test('postgres: full approval flow, RLS isolation, immutable audit', { skip: !PG }, async () => {
  const org = `org-${uid()}`; const applied = [];
  const store = new PgStore(PG);
  const engine = mkEngine(store, applied);
  await engine.publish(org, wf);
  const ex = await engine.start(org, 'rightsize-with-approval@1', { resource: 'i-1' }, { actor: 'u-dev' });
  assert.equal(ex.status, 'WAITING_APPROVAL');
  assert.equal(applied.length, 0);
  const [ap] = await store.list('approvals', org);
  const done = await engine.decide(org, ap.id, { ...approver, orgId: org }, 'approved');
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(applied.length, 1);

  // new engine instance (simulated restart) sees the persisted execution
  const again = await mkEngine(new PgStore(PG), applied).get(org, ex.id);
  assert.equal(again.status, 'SUCCEEDED');

  // RLS: other org's session sees nothing, even with a raw query
  const other = await store.tx('someone-else', (c) => c.query('SELECT count(*)::int n FROM engine_documents'));
  assert.equal(other.rows[0].n, 0);
  assert.equal((await store.tx(org, (c) => c.query('SELECT count(*)::int n FROM engine_documents'))).rows[0].n > 0, true);
  // writing a row for a different org is rejected by WITH CHECK
  await assert.rejects(store.tx('someone-else', (c) => c.query(
    "INSERT INTO engine_documents (org_id, kind, id, doc) VALUES ($1,'x','y','{}')", [org])), /row-level security/);

  // audit entries cannot be modified or deleted by the app role
  await assert.rejects(store.tx(org, (c) => c.query("DELETE FROM engine_documents WHERE kind='audit'")), /immutable/);
  await assert.rejects(store.tx(org, (c) => c.query("UPDATE engine_documents SET doc='{}' WHERE kind='audit'")), /immutable/);
  await store.close();
});

test('bullmq: idempotent enqueue, worker run, approval pause and resume', { skip: !(PG && REDIS) }, async () => {
  const org = `org-${uid()}`; const applied = [];
  const store = new PgStore(PG);
  const engine = mkEngine(store, applied);
  await engine.publish(org, wf);
  const conn = new IORedis(REDIS, { maxRetriesPerRequest: null });
  const q = new ExecutionQueue(conn, `test-${uid()}`);
  const worker = q.startWorker(engine);
  try {
    const finished = (name) => new Promise((res) => worker.on('completed', (job, r) => { if (job.name === name) res(r); }));
    const first = finished('start');
    await q.enqueueStart(org, 'rightsize-with-approval@1', { resource: 'i-9' }, { eventId: 'anom:1', actor: 'u-dev' });
    await q.enqueueStart(org, 'rightsize-with-approval@1', { resource: 'i-9' }, { eventId: 'anom:1', actor: 'u-dev' }); // duplicate delivery
    const r = await first;
    assert.equal(r.status, 'WAITING_APPROVAL');
    assert.equal((await store.list('executions', org)).length, 1);
    const [ap] = await store.list('approvals', org);
    await engine.decide(org, ap.id, { ...approver, orgId: org }, 'approved', '', { defer: true });
    assert.equal(applied.length, 0, 'decision alone does not execute; the worker does');
    const second = finished('resume');
    await q.enqueueResume(org, r.execId);
    assert.equal((await second).status, 'SUCCEEDED');
    assert.equal(applied.length, 1);
  } finally { await q.close(); await conn.quit(); await store.close(); }
});
