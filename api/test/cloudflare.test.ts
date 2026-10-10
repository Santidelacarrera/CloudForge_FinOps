// CloudflareProvider against a mock of the Cloudflare KV API, then the full approved-remediation flow through the platform.
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

const ROOT = path.resolve(__dirname, '../..');
const PG = process.env.CLOUDFORGE_PG_URL; const REDIS = process.env.REDIS_URL;
const skip = !(PG && REDIS);
const READ = 'cf-read-token'; const WRITE = 'cf-write-token-SECRET'; const ACCOUNT = 'acc123';
process.env.JWT_SECRET = 'test-secret-test-secret';
const org = `org-cf-${Math.random().toString(36).slice(2, 7)}`;
let app: any; let base = ''; let py: ChildProcess; let mock: any; let signJwt: any;
const tok = (sub: string, roles: string[]) => signJwt({ sub, org, roles }, process.env.JWT_SECRET!);
const call = async (method: string, url: string, token: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const until = async (fn: () => Promise<boolean>, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };
const many = Array.from({ length: 130 }, (_, i) => ({ id: `ns${String(i).padStart(3, '0')}`, title: `many-${i}`, keys: ['k'] }));
const mkMock = async () => {
  const { createCloudflareMock } = await import('../../providers/cloudflare-mock/server.mjs');
  const m = createCloudflareMock({ accountId: ACCOUNT, readToken: READ, writeToken: WRITE, namespaces: [
    { id: 'emptyns1', title: 'old-cache', keys: [] }, { id: 'usedns02', title: 'sessions', keys: ['a', 'b'] }, ...many] });
  await new Promise<void>((r) => m.server.listen(0, r));
  return { m, url: `http://127.0.0.1:${m.server.address().port}/client/v4` };
};

before(async () => {
  if (skip) return;
  const { m, url } = await mkMock(); mock = m;
  Object.assign(process.env, {
    DATABASE_URL: PG, REDIS_URL: REDIS, ANALYTICS_URL: 'http://127.0.0.1:8767', QUEUE_NAME: `cf-${org}`,
    PROVIDER_KIND: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_READ_TOKEN: READ, CLOUDFLARE_API_URL: url,
    CRED_CRED_REMEDIATION_SCOPED: WRITE,
  });
  py = spawn('python3', ['-m', 'uvicorn', 'cloudforge_analytics.api:app', '--port', '8767', '--log-level', 'warning'], { cwd: path.join(ROOT, 'analytics'), stdio: 'inherit' });
  await until(async () => fetch('http://127.0.0.1:8767/healthz').then((r) => r.ok).catch(() => false), 15000);
  ({ signJwt } = await import('../src/auth'));
  app = await (await import('../src/main')).createApp();
  await app.listen(0);
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});
after(async () => { await app?.close(); py?.kill(); mock?.server.close(); });

test('adapter: pagination, transient vs permanent errors, read token cannot delete', { skip }, async () => {
  const { CloudflareProvider } = await import('../src/cloudflare');
  const { m: m2, url } = await mkMock();
  const p = new CloudflareProvider({ accountId: ACCOUNT, readToken: READ, baseUrl: url });
  assert.equal((await p.listNamespaces()).length, 132, 'followed all pages');
  m2.rateLimit(1);
  await assert.rejects(p.listNamespaces(), (e: any) => !e.name.includes('Permanent') && /429/.test(e.message), '429 is transient (retried by the engine)');
  await assert.rejects(p.deleteResource('kv:emptyns1', READ, 'k'), /must differ/);
  await assert.rejects(p.deleteResource('kv:emptyns1', undefined, 'k'), /not configured/);
  await assert.rejects(p.deleteResource('kv:usedns02', WRITE, 'k'), /no longer empty/);
  assert.ok(m2.ns.has('usedns02'));
  await assert.rejects(p.deleteResource('worker:x', WRITE, 'k'), /unsupported/);
  await assert.rejects(new CloudflareProvider({ accountId: ACCOUNT, readToken: 'bad', baseUrl: url }).listNamespaces(), /401/);
  // the real API refuses a read-only token on DELETE; the mock models that
  const r = await fetch(`${url}/accounts/${ACCOUNT}/storage/kv/namespaces/emptyns1`, { method: 'DELETE', headers: { authorization: `Bearer ${READ}` } });
  assert.equal(r.status, 403);
  // already gone -> desired state holds, reported explicitly
  assert.equal((await p.deleteResource('kv:emptyns1', WRITE, 'k1')).deleted, 'kv:emptyns1');
  assert.equal((await p.deleteResource('kv:emptyns1', WRITE, 'k1')).alreadyAbsent, true);
  m2.server.close();
});

test('platform: only the empty namespace is recommended; approved remediation deletes it; credential never leaks', { skip }, async () => {
  const ana = tok('ana', ['analyst']); const dev = tok('dev', ['operator']); const fin = tok('fin', ['approver']);
  const recs = (await call('GET', '/api/v1/recommendations', ana)).body;
  assert.equal(recs.length, 1);
  assert.equal(recs[0].resource_id, 'kv:emptyns1');
  assert.ok(mock.log.every((l: string) => !l.startsWith('write')), 'read phase used the read token only');

  const sim = await call('POST', `/api/v1/recommendations/${recs[0].id}/simulate`, ana);
  assert.equal(sim.body.plan.dryRun, true);
  assert.ok(mock.ns.has('emptyns1'), 'simulation changed nothing');

  const wf = JSON.parse(readFileSync(path.join(ROOT, 'examples/workflows/orphan-cleanup-with-approval.json'), 'utf8'));
  await call('POST', '/api/v1/workflows', dev, wf);
  const run = await call('POST', `/api/v1/workflows/${wf.id}/run`, dev, { input: { recommendationId: recs[0].id } }, { 'idempotency-key': 'cf-1' });
  await until(async () => (await call('GET', `/api/v1/executions/${run.body.executionId}`, dev)).body.status === 'WAITING_APPROVAL');
  assert.ok(mock.ns.has('emptyns1'), 'still exists while waiting for a human');
  assert.ok(!mock.log.some((l: string) => l.startsWith('write')), 'no write call before approval');

  // data arrives after the plan was approved -> adapter refuses (time-of-check/time-of-use guard)
  mock.ns.get('emptyns1').keys.push('late-write');
  const [ap] = (await call('GET', '/api/v1/approvals?status=pending', dev)).body;
  await call('POST', `/api/v1/approvals/${ap.id}/decision`, fin, { decision: 'approved' });
  await until(async () => (await call('GET', `/api/v1/executions/${run.body.executionId}`, dev)).body.status === 'FAILED');
  assert.ok(mock.ns.has('emptyns1'), 'non-empty namespace was NOT deleted');
  const failed = (await call('GET', `/api/v1/executions/${run.body.executionId}`, dev)).body;
  assert.equal(failed.steps.find((s: any) => s.nodeId === 'apply').attempts, 1);

  // empty again -> new run, approved -> deleted
  mock.ns.get('emptyns1').keys.length = 0;
  const run2 = await call('POST', `/api/v1/workflows/${wf.id}/run`, dev, { input: { recommendationId: recs[0].id } }, { 'idempotency-key': 'cf-2' });
  await until(async () => (await call('GET', `/api/v1/executions/${run2.body.executionId}`, dev)).body.status === 'WAITING_APPROVAL');
  const [ap2] = (await call('GET', '/api/v1/approvals?status=pending', dev)).body;
  await call('POST', `/api/v1/approvals/${ap2.id}/decision`, fin, { decision: 'approved' });
  await until(async () => (await call('GET', `/api/v1/executions/${run2.body.executionId}`, dev)).body.status === 'SUCCEEDED');
  assert.equal(mock.ns.has('emptyns1'), false, 'deleted');
  assert.ok(mock.ns.has('usedns02') && mock.ns.size === 131, 'nothing else touched');
  const done = (await call('GET', `/api/v1/executions/${run2.body.executionId}`, dev)).body;
  assert.ok(!JSON.stringify(done).includes(WRITE));
  assert.ok(!JSON.stringify(await app.get((await import('../src/core.service')).CoreService).store.list('audit', org)).includes(WRITE));
});

test('sync imports estimate rows for every namespace', { skip }, async () => {
  const ana = tok('ana', ['analyst']);
  const r = await call('POST', '/api/v1/connectors/sync', ana, { from: '2026-09-01', to: '2026-09-02' });
  assert.equal(r.status, 201);
  assert.equal(r.body.received, 131 * 2);
});
