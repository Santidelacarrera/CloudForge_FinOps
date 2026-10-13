// Seeds a running stack: imports the sample dataset, publishes the workflow, sets a budget and starts one run.
// usage: JWT_SECRET=... API=http://127.0.0.1:3000 ORG=demo-org node scripts/seed-demo.mjs
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = process.env.API ?? 'http://127.0.0.1:3000';
const ORG = process.env.ORG ?? 'demo-org';
const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('JWT_SECRET required');
const b64 = (s) => Buffer.from(s).toString('base64url');
export const token = (sub, roles) => {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify({ sub, org: ORG, roles, exp: Math.floor(Date.now() / 1000) + 86400 }));
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
};
const call = async (method, path, t, body, headers = {}) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}`, ...headers }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};

if (process.argv[1].endsWith('seed-demo.mjs')) {
  const truth = JSON.parse(readFileSync('datasets/ground_truth.json', 'utf8'));
  const ana = token('ana', ['analyst']); const dev = token('dev', ['operator']);
  console.log(await call('POST', '/api/v1/cost-imports', ana, { name: 'sample_billing.csv', csv: readFileSync('datasets/sample_billing.csv', 'utf8'), rates: truth.fx_rates }).then((r) => ({ inserted: r.inserted, rejected: r.rejected.length })));
  for (const b of JSON.parse(readFileSync('datasets/budgets.json', 'utf8')).budgets) {
    await call('PUT', `/api/v1/budgets/${b.month}`, ana, { amount: b.amount, scope_type: b.scope_type, scope_value: b.scope_value });
  }
  console.log(await call('POST', '/api/v1/workflows', dev, JSON.parse(readFileSync('examples/workflows/orphan-cleanup-with-approval.json', 'utf8'))));
  const recs = await call('GET', '/api/v1/recommendations', ana);
  console.log(await call('POST', '/api/v1/workflows/orphan-cleanup-with-approval/run', dev, { input: { recommendationId: recs[0].id } }, { 'idempotency-key': 'demo-1' }));
  console.log('tokens:\n analyst :', ana, '\n operator:', dev, '\n approver:', token('fin', ['approver']));
}
