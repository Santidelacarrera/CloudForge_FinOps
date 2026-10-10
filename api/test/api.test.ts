// End-to-end: NestJS API + real PostgreSQL + real Redis/BullMQ + real FastAPI analytics service.
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const PG = process.env.CLOUDFORGE_PG_URL; const REDIS = process.env.REDIS_URL;
const skip = !(PG && REDIS);
process.env.JWT_SECRET = 'test-secret-test-secret';
const csv = skip ? '' : readFileSync(path.join(ROOT, 'datasets/sample_billing.csv'), 'utf8');
const truth = skip ? {} as any : JSON.parse(readFileSync(path.join(ROOT, 'datasets/ground_truth.json'), 'utf8'));
const wf = skip ? {} : JSON.parse(readFileSync(path.join(ROOT, 'examples/workflows/orphan-cleanup-with-approval.json'), 'utf8'));

let app: any; let base = ''; let py: ChildProcess;
const org = `org-${Math.random().toString(36).slice(2, 8)}`;
let signJwt: any;
const tok = (sub: string, roles: string[], o = org) => signJwt({ sub, org: o, roles }, process.env.JWT_SECRET!);
const call = async (method: string, url: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const until = async (fn: () => Promise<boolean>, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout waiting for condition'); };

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = PG; process.env.REDIS_URL = REDIS; process.env.ANALYTICS_URL = 'http://127.0.0.1:8765';
  process.env.QUEUE_NAME = `api-test-${org}`;
  py = spawn('python3', ['-m', 'uvicorn', 'cloudforge_analytics.api:app', '--port', '8765', '--log-level', 'warning'], { cwd: path.join(ROOT, 'analytics'), stdio: 'inherit' });
  await until(async () => fetch('http://127.0.0.1:8765/healthz').then((r) => r.ok).catch(() => false), 15000);
  ({ signJwt } = await import('../src/auth'));
  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.listen(0);
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});
after(async () => { await app?.close(); py?.kill(); });

test('authentication: missing, forged and expired tokens are rejected', { skip }, async () => {
  assert.equal((await call('GET', '/api/v1/costs/summary', null)).status, 401);
  assert.equal((await call('GET', '/api/v1/costs/summary', tok('u', []) + 'x')).status, 401);
  const expired = signJwt({ sub: 'u', org, roles: [], exp: 1 }, process.env.JWT_SECRET);
  assert.equal((await call('GET', '/api/v1/costs/summary', expired)).status, 401);
  // alg=none forgery
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'u', org, roles: ['admin'], exp: 9999999999 })).toString('base64url')}.`;
  assert.equal((await call('GET', '/api/v1/costs/summary', none)).status, 401);
  assert.equal((await call('POST', '/api/v1/cost-imports', tok('v', ['viewer']), { csv })).status, 403);
});

test('import is idempotent; totals trace to source records', { skip }, async () => {
  const t = tok('ana', ['analyst']);
  const first = await call('POST', '/api/v1/cost-imports', t, { name: 'sample.csv', csv, rates: truth.fx_rates });
  assert.equal(first.status, 201);
  assert.equal(first.body.rejected.length, truth.expected_rejected);
  assert.equal(first.body.duplicates.length, truth.expected_duplicates);
  assert.equal(first.body.inserted, first.body.received);
  const again = await call('POST', '/api/v1/cost-imports', t, { csv, rates: truth.fx_rates });
  assert.equal(again.body.inserted, 0);
  assert.equal(again.body.already_present, first.body.received);

  const s = await call('GET', '/api/v1/costs/summary?group_by=service', t);
  const sum = s.body.groups.reduce((a: number, g: any) => a + Number(g.total), 0);
  const n = s.body.groups.reduce((a: number, g: any) => a + g.record_count, 0);
  assert.equal(n, first.body.received);
  for (const g of s.body.groups) assert.equal(g.record_ids.length, g.record_count);
  assert.ok(sum > 0);
  assert.equal((await call('GET', '/api/v1/costs/summary?group_by=password', t)).status, 400);
  assert.equal((await call('GET', "/api/v1/costs/summary?from=2026-01-01'--", t)).status, 400);
});

test('anomalies and forecast expose method and uncertainty', { skip }, async () => {
  const t = tok('ana', ['analyst']);
  const a = await call('GET', '/api/v1/anomalies', t);
  assert.deepEqual(new Set(a.body.map((x: any) => `${x.series}|${x.date}`)), new Set(truth.injected_anomalies.map((x: any) => `${x.series}|${x.date}`)));
  assert.ok(a.body[0].method.name && a.body[0].explanation);
  await call('PUT', '/api/v1/budgets/2026-09', t, { amount: 9000 });
  const f = await call('GET', '/api/v1/forecasts?as_of=2026-09-15', t);
  assert.equal(f.status, 200);
  assert.equal(f.body.budget, 9000);
  assert.ok(f.body.interval_95[0] < f.body.point_estimate && f.body.assumptions.length);
});

let recId = ''; let execId = ''; let approvalId = '';
test('simulate produces a stored dry-run plan', { skip }, async () => {
  const t = tok('ana', ['analyst']);
  const recs = await call('GET', '/api/v1/recommendations', t);
  const rec = recs.body.find((r: any) => r.resource_id === truth.orphan_resource);
  assert.ok(rec); recId = rec.id;
  assert.ok(rec.evidence.sample_record_ids.length > 0);
  const sim = await call('POST', `/api/v1/recommendations/${recId}/simulate`, t);
  assert.equal(sim.status, 200);
  assert.equal(sim.body.plan.dryRun, true);
  assert.match(sim.body.plan.terraformDiff, /1 to destroy/);
  assert.equal((await call('POST', '/api/v1/recommendations/rec-nope/simulate', t)).status, 404);
});

test('workflow pauses for approval; only an authorised other user can approve; then it executes once', { skip }, async () => {
  const dev = tok('dev', ['operator']);
  const pub = await call('POST', '/api/v1/workflows', dev, wf);
  assert.equal(pub.status, 201);
  // a definition that applies without approval is refused at publish time
  const bad = await call('POST', '/api/v1/workflows', dev, { id: 'bad', nodes: [{ id: 'a', type: 'apply_plan', params: { planFrom: 'p' } }], edges: [] });
  assert.equal(bad.status, 400);

  const run = await call('POST', `/api/v1/workflows/${wf.id}/run`, dev, { input: { recommendationId: recId } }, { 'idempotency-key': 'evt-1' });
  assert.equal(run.status, 202);
  execId = run.body.executionId;
  const dup = await call('POST', `/api/v1/workflows/${wf.id}/run`, dev, { input: { recommendationId: recId } }, { 'idempotency-key': 'evt-1' });
  assert.equal(dup.body.executionId, execId);

  await until(async () => (await call('GET', `/api/v1/executions/${execId}`, dev)).body.status === 'WAITING_APPROVAL');
  const ex = (await call('GET', `/api/v1/executions/${execId}`, dev)).body;
  assert.equal(ex.outputs.plan.dryRun, true);
  assert.equal(ex.outputs.apply, undefined, 'nothing applied before approval');
  assert.equal((await call('GET', '/api/v1/executions', dev)).body.length, 1);

  const pending = (await call('GET', '/api/v1/approvals?status=pending', dev)).body;
  assert.equal(pending.length, 1); approvalId = pending[0].id;

  const decide = (t: string, d = 'approved') => call('POST', `/api/v1/approvals/${approvalId}/decision`, t, { decision: d });
  assert.equal((await decide(dev)).status, 403, 'no approver role');
  assert.equal((await decide(tok('dev', ['operator', 'approver']))).status, 403, 'requester cannot self-approve');
  assert.equal((await decide(tok('eve', ['approver'], 'other-org'))).status, 404, 'other tenant cannot see it');
  assert.equal((await call('POST', `/api/v1/approvals/${approvalId}/decision`, tok('fin', ['approver']), { decision: 'maybe' })).status, 400);

  const ok = await decide(tok('fin', ['approver']));
  assert.equal(ok.status, 200);
  await until(async () => (await call('GET', `/api/v1/executions/${execId}`, dev)).body.status === 'SUCCEEDED');
  const done = (await call('GET', `/api/v1/executions/${execId}`, dev)).body;
  assert.equal(done.outputs.apply.mode, 'demo-no-cloud-call');
  assert.equal((await decide(tok('fin', ['approver']))).status, 400, 'decision cannot be replayed');
  const audit = (await app.get((await import('../src/core.service')).CoreService).store.list('audit', org)).map((a: any) => a.action);
  for (const a of ['workflow.published', 'approval.requested', 'approval.approved', 'execution.succeeded']) assert.ok(audit.includes(a), a);
});

test('tenant isolation over the API', { skip }, async () => {
  const other = tok('x', ['analyst', 'operator'], 'org-intruder');
  assert.equal((await call('GET', `/api/v1/executions/${execId}`, other)).status, 404);
  assert.deepEqual((await call('GET', '/api/v1/costs/summary', other)).body.groups, []);
  assert.deepEqual((await call('GET', '/api/v1/recommendations', other)).body, []);
  assert.equal((await call('POST', `/api/v1/recommendations/${recId}/simulate`, other)).status, 404);
});
