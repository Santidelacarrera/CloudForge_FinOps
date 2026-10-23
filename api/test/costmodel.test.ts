// Cost model end to end on the simulated dataset: scoped budgets, allocation/coverage, variance, persisted anomalies
// and forecasts, and the budget trigger. Expectations are recomputed from raw CSV rows.
import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

const ROOT = path.resolve(__dirname, '../..');
const PG = process.env.CLOUDFORGE_PG_URL; const REDIS = process.env.REDIS_URL;
const skip = !(PG && REDIS);
process.env.JWT_SECRET = 'test-secret-test-secret';
const csv = skip ? '' : readFileSync(path.join(ROOT, 'datasets/sample_billing.csv'), 'utf8');
const truth = skip ? ({} as any) : JSON.parse(readFileSync(path.join(ROOT, 'datasets/ground_truth.json'), 'utf8'));
const budgets = skip ? [] : JSON.parse(readFileSync(path.join(ROOT, 'datasets/budgets.json'), 'utf8')).budgets;
const org = `org-cm-${Math.random().toString(36).slice(2, 7)}`;
let app: any; let base = ''; let py: ChildProcess; let signJwt: any;
const tok = (sub: string, roles: string[], o = org) => signJwt({ sub, org: o, roles }, process.env.JWT_SECRET!);
const call = async (method: string, url: string, token: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const until = async (fn: () => Promise<boolean>, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };

/** Independent aggregation of the CSV (dedupe + validity rules re-implemented here). */
function rawRows() {
  const [head, ...lines] = csv.trim().split(/\r?\n/); const cols = head.split(',');
  const seen = new Set<string>(); const out: any[] = [];
  for (const l of lines) {
    if (seen.has(l)) continue; seen.add(l);
    const v = l.split(','); const r: any = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    const rate = truth.fx_rates[r.currency]; const cost = Number(r.cost);
    if (!rate || Number.isNaN(cost)) continue;
    out.push({ ...r, usd: cost * rate });
  }
  return out;
}

before(async () => {
  if (skip) return;
  Object.assign(process.env, { DATABASE_URL: PG, REDIS_URL: REDIS, ANALYTICS_URL: 'http://127.0.0.1:8768', QUEUE_NAME: `cm-${org}` });
  py = spawn('python3', ['-m', 'uvicorn', 'cloudforge_analytics.api:app', '--port', '8768', '--log-level', 'warning'], { cwd: path.join(ROOT, 'analytics'), stdio: 'inherit' });
  await until(async () => fetch('http://127.0.0.1:8768/healthz').then((r) => r.ok).catch(() => false), 15000);
  ({ signJwt } = await import('../src/auth'));
  app = await (await import('../src/main')).createApp();
  await app.listen(0);
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});
after(async () => { await app?.close(); py?.kill(); });

test('setup: import the simulated dataset and the simulated budgets', { skip }, async () => {
  const ana = tok('ana', ['analyst']);
  assert.equal((await call('POST', '/api/v1/cost-imports', ana, { csv, rates: truth.fx_rates })).status, 201);
  for (const b of budgets) {
    assert.equal((await call('PUT', `/api/v1/budgets/${b.month}`, ana, { amount: b.amount, scope_type: b.scope_type, scope_value: b.scope_value })).status, 200);
  }
  assert.equal((await call('GET', '/api/v1/budgets/status?month=2026-09', ana)).body.length, budgets.length);
});

test('budget validation and roles', { skip }, async () => {
  const ana = tok('ana', ['analyst']);
  const put = (body: any, month = '2026-09', t = ana) => call('PUT', `/api/v1/budgets/${month}`, t, body);
  assert.equal((await put({ amount: -5 })).status, 400);
  assert.equal((await put({ amount: 'x' })).status, 400);
  assert.equal((await put({ amount: 10 }, '2026-13')).status, 400);
  assert.equal((await put({ amount: 10, scope_type: 'galaxy', scope_value: 'x' })).status, 400);
  assert.equal((await put({ amount: 10, scope_type: 'service' })).status, 400, 'scoped budget needs a value');
  assert.equal((await put({ amount: 10, thresholds: [0] })).status, 400);
  assert.equal((await put({ amount: 10, thresholds: [11] })).status, 400);
  assert.equal((await put({ amount: 10 }, '2026-09', tok('v', ['viewer']))).status, 403);
  assert.equal((await call('GET', '/api/v1/budgets/status?month=bad', ana)).status, 400);
  // SQL-injection shaped scope values are stored as data and never reach the SQL text
  assert.equal((await put({ amount: 10, scope_type: 'service', scope_value: "x'; DROP TABLE budgets;--" }, '2026-10')).status, 200);
  assert.equal((await call('GET', '/api/v1/budgets/status?month=2026-10', ana)).body[0].status, 'no_data');
});

test('budget status: mid-month projection, month-end overrun, explainable output', { skip }, async () => {
  const ana = tok('ana', ['analyst']);
  const mid = (await call('GET', '/api/v1/budgets/status?month=2026-09&as_of=2026-09-15', ana)).body;
  const by = Object.fromEntries(mid.map((s: any) => [s.scope_value || 'total', s]));
  assert.equal(by.Database.status, 'at_risk');
  assert.equal(by.Compute.status, 'at_risk');
  assert.equal(by.ObjectStorage.status, 'ok');
  assert.equal(by.Functions.status, 'ok');
  assert.equal(by.total.status, 'ok');
  // month-to-date equals the independent sum from the raw CSV
  const raw = rawRows().filter((r) => r.service === 'Database' && r.date >= '2026-09-01' && r.date <= '2026-09-15').reduce((a, r) => a + r.usd, 0);
  assert.ok(Math.abs(by.Database.month_to_date - raw) < 0.01, `${by.Database.month_to_date} vs ${raw}`);
  assert.ok(by.Database.assumptions.length && by.Database.method.name);
  const end = (await call('GET', '/api/v1/budgets/status?month=2026-09&as_of=2026-09-30', ana)).body;
  const db = end.find((s: any) => s.scope_value === 'Database');
  assert.equal(db.status, 'exceeded');
  assert.deepEqual(db.events.map((e: any) => e.threshold), [0.5, 0.8, 1]);
});

test('allocation: coverage and unallocated cost match an independent computation', { skip }, async () => {
  const ana = tok('ana', ['analyst']);
  const r = (await call('GET', '/api/v1/costs/allocation?by=owner', ana)).body;
  const rows = rawRows();
  const total = rows.reduce((a, x) => a + x.usd, 0);
  const unalloc = rows.filter((x) => !/owner=/.test(x.tags)).reduce((a, x) => a + x.usd, 0);
  assert.ok(Math.abs(Number(r.total) - total) < 0.01);
  assert.ok(Math.abs(Number(r.unallocated_total) - unalloc) < 0.01);
  assert.ok(Math.abs(r.coverage_pct - (100 * (total - unalloc)) / total) < 0.1);
  const g = r.groups.find((x: any) => x.group === 'unallocated');
  assert.equal(g.record_ids.length, g.record_count, 'traceable to records');
  const byProject = (await call('GET', '/api/v1/costs/allocation?by=project', ana)).body;
  assert.ok(byProject.groups.some((x: any) => x.group === 'checkout'));
  assert.equal((await call('GET', '/api/v1/costs/allocation?by=password', ana)).status, 400);
});

test('variance: like-for-like against the previous month', { skip }, async () => {
  const v = (await call('GET', '/api/v1/costs/variance?as_of=2026-09-25', tok('ana', ['analyst']))).body;
  assert.equal(v.prior_month, '2026-08');
  const row = v.rows.find((x: any) => x.series === 'ObjectStorage');
  const cur = rawRows().filter((r) => r.service === 'ObjectStorage' && r.date >= '2026-09-01' && r.date <= '2026-09-25').reduce((a, r) => a + r.usd, 0);
  assert.ok(Math.abs(row.current - cur) < 0.01);
  assert.ok(row.pct > 5);
});

test('anomalies are persisted entities with a lifecycle; forecasts are stored snapshots', { skip }, async () => {
  const ana = tok('ana', ['analyst']);
  const first = (await call('GET', '/api/v1/anomalies', ana)).body;
  assert.equal(first.length, truth.injected_anomalies.length);
  assert.ok(first.every((a: any) => a.id.startsWith('an-') && a.status === 'open'));
  const again = (await call('GET', '/api/v1/anomalies', ana)).body;
  assert.deepEqual(again.map((a: any) => a.id), first.map((a: any) => a.id), 'stable ids across detections');
  assert.equal((await call('POST', `/api/v1/anomalies/${first[0].id}/ack`, tok('v', ['viewer']))).status, 403);
  assert.equal((await call('POST', `/api/v1/anomalies/${first[0].id}/ack`, ana)).status, 200);
  const open = (await call('GET', '/api/v1/anomalies?status=open', ana)).body;
  assert.equal(open.length, first.length - 1);
  assert.equal((await call('GET', '/api/v1/anomalies', ana)).body.find((a: any) => a.id === first[0].id).status, 'acknowledged', 're-detection keeps the acknowledgement');
  assert.equal((await call('POST', '/api/v1/anomalies/an-nope/ack', ana)).status, 404);
  assert.equal((await call('GET', '/api/v1/anomalies?status=weird', ana)).status, 400);

  const f1 = (await call('GET', '/api/v1/forecasts?as_of=2026-09-15', ana)).body;
  const f2 = (await call('GET', '/api/v1/forecasts?as_of=2026-09-15', ana)).body;
  assert.equal(f1.id, f2.id, 'same forecast -> same snapshot');
  assert.equal(f1.budget, 9000, 'total budget of the month is applied');
  const hist = (await call('GET', '/api/v1/forecasts/history', ana)).body;
  assert.equal(hist.length, 1);
  assert.ok(hist[0].assumptions.length && hist[0].method.name && hist[0].interval_95.length === 2);
});

test('budget trigger starts a workflow once per crossed threshold', { skip }, async () => {
  const dev = tok('dev', ['operator']);
  const wf = { id: 'budget-alert', trigger: { type: 'budget.threshold', filter: { scope_type: 'service', scope_value: 'Database', minThreshold: 1 } },
    nodes: [{ id: 'n', type: 'notify', params: { message: 'Budget {{input.budget.scope_value}} crossed {{input.threshold}} ({{input.pct}}%)' } }], edges: [] };
  assert.equal((await call('POST', '/api/v1/workflows', dev, wf)).status, 201);
  const first = (await call('POST', '/api/v1/triggers/evaluate', dev)).body;
  assert.equal(first.length, 1, 'only the Database budget (>=100%) matches the filter');
  await until(async () => (await call('GET', `/api/v1/executions/${first[0].executionId}`, dev)).body.status === 'SUCCEEDED');
  const ex = (await call('GET', `/api/v1/executions/${first[0].executionId}`, dev)).body;
  assert.match(ex.outputs.n.text, /Budget Database crossed 1 \(\d+/);
  await call('POST', '/api/v1/triggers/evaluate', dev);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await call('GET', '/api/v1/executions', dev)).body.length, 1, 'idempotent');
});

test('tenant isolation for the cost model', { skip }, async () => {
  const other = tok('x', ['analyst', 'operator'], 'org-other');
  assert.deepEqual((await call('GET', '/api/v1/budgets/status', other)).body, []);
  assert.deepEqual((await call('GET', '/api/v1/anomalies', other)).body, []);
  assert.deepEqual((await call('GET', '/api/v1/forecasts/history', other)).body, []);
  assert.equal((await call('GET', '/api/v1/costs/allocation', other)).body.groups.length, 0);
  assert.equal((await call('POST', `/api/v1/anomalies/an-x/ack`, other)).status, 404);
});
