// End-to-end against the LocalCloud provider: read-only sync, then an approved remediation that really deletes the resource.
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

const ROOT = path.resolve(__dirname, '../..');
const PG = process.env.CLOUDFORGE_PG_URL; const REDIS = process.env.REDIS_URL;
const skip = !(PG && REDIS);
const WRITE = 'write-token-SECRET-value';
process.env.JWT_SECRET = 'test-secret-test-secret';
const org = `org-prov-${Math.random().toString(36).slice(2, 7)}`;
let app: any; let base = ''; let py: ChildProcess; let cloud: any; let signJwt: any;
const tok = (sub: string, roles: string[]) => signJwt({ sub, org, roles }, process.env.JWT_SECRET!);
const call = async (method: string, url: string, token: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const until = async (fn: () => Promise<boolean>, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };

before(async () => {
  if (skip) return;
  const lc = await import('../../providers/localcloud/server.mjs');
  cloud = lc.createCloud({ readToken: 'read-token-value', writeToken: WRITE });
  await new Promise<void>((r) => cloud.server.listen(0, r));
  Object.assign(process.env, {
    DATABASE_URL: PG, REDIS_URL: REDIS, ANALYTICS_URL: 'http://127.0.0.1:8766', QUEUE_NAME: `prov-${org}`,
    PROVIDER_URL: `http://127.0.0.1:${cloud.server.address().port}`, PROVIDER_READ_TOKEN: 'read-token-value',
    CRED_CRED_REMEDIATION_SCOPED: WRITE,
  });
  py = spawn('python3', ['-m', 'uvicorn', 'cloudforge_analytics.api:app', '--port', '8766', '--log-level', 'warning'], { cwd: path.join(ROOT, 'analytics'), stdio: 'inherit' });
  await until(async () => fetch('http://127.0.0.1:8766/healthz').then((r) => r.ok).catch(() => false), 15000);
  ({ signJwt } = await import('../src/auth'));
  app = await (await import('../src/main')).createApp();
  await app.listen(0);
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});
after(async () => { await app?.close(); py?.kill(); cloud?.server.close(); });

test('sync uses only the read-only token; remediation really deletes the approved orphan, once', { skip }, async () => {
  const ana = tok('ana', ['analyst']); const dev = tok('dev', ['operator']); const fin = tok('fin', ['approver']);
  const sync = await call('POST', '/api/v1/connectors/sync', ana, { rates: { EUR: 1.1 } });
  assert.equal(sync.status, 201);
  assert.ok(sync.body.inserted > 300);
  assert.ok(cloud.log.length > 0 && cloud.log.every((l: string) => l.startsWith('read GET')), 'sync touched the provider with the read token only');

  const wf = JSON.parse(readFileSync(path.join(ROOT, 'examples/workflows/orphan-cleanup-with-approval.json'), 'utf8'));
  assert.equal((await call('POST', '/api/v1/workflows', dev, wf)).status, 201);
  const rec = (await call('GET', '/api/v1/recommendations', ana)).body.find((r: any) => r.resource_id === 'vol-0orphan01');
  const run = await call('POST', `/api/v1/workflows/${wf.id}/run`, dev, { input: { recommendationId: rec.id } }, { 'idempotency-key': 'a' });
  await until(async () => (await call('GET', `/api/v1/executions/${run.body.executionId}`, dev)).body.status === 'WAITING_APPROVAL');
  assert.ok(cloud.resources.has('vol-0orphan01'), 'still exists while waiting for the human');
  assert.ok(!cloud.log.some((l: string) => l.startsWith('write')), 'no write call before approval');

  const [ap] = (await call('GET', '/api/v1/approvals?status=pending', dev)).body;
  assert.equal((await call('POST', `/api/v1/approvals/${ap.id}/decision`, fin, { decision: 'approved' })).status, 200);
  await until(async () => (await call('GET', `/api/v1/executions/${run.body.executionId}`, dev)).body.status === 'SUCCEEDED');
  assert.equal(cloud.resources.has('vol-0orphan01'), false, 'resource was really deleted');
  assert.ok(cloud.resources.has('database-main'), 'nothing else was touched');
  const done = (await call('GET', `/api/v1/executions/${run.body.executionId}`, dev)).body;
  assert.equal(done.outputs.apply.mode, 'provider');
  assert.ok(!JSON.stringify(done).includes(WRITE), 'credential never appears in execution state');
  const audit = JSON.stringify(await app.get((await import('../src/core.service')).CoreService).store.list('audit', org));
  assert.ok(!audit.includes(WRITE));

  // a second, separately approved run for the same (now gone) resource fails permanently without retry storms
  const run2 = await call('POST', `/api/v1/workflows/${wf.id}/run`, dev, { input: { recommendationId: rec.id } }, { 'idempotency-key': 'b' });
  await until(async () => (await call('GET', `/api/v1/executions/${run2.body.executionId}`, dev)).body.status === 'WAITING_APPROVAL');
  const [ap2] = (await call('GET', '/api/v1/approvals?status=pending', dev)).body;
  await call('POST', `/api/v1/approvals/${ap2.id}/decision`, fin, { decision: 'approved' });
  await until(async () => (await call('GET', `/api/v1/executions/${run2.body.executionId}`, dev)).body.status === 'FAILED');
  const failed = (await call('GET', `/api/v1/executions/${run2.body.executionId}`, dev)).body;
  assert.equal(failed.steps.find((s: any) => s.nodeId === 'apply').attempts, 1);
  assert.match(failed.steps.find((s: any) => s.nodeId === 'apply').error, /404/);
});
