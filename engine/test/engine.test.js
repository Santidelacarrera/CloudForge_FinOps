import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Engine, MemoryStore, assertSafeWebhook, redact, validateDefinition } from '../src/index.js';

const ORG = 'org-a';
const requester = { id: 'u-dev', orgId: ORG, roles: ['viewer'] };
const approver = { id: 'u-fin', orgId: ORG, roles: ['approver'] };

const workflow = JSON.parse(readFileSync(new URL('../../examples/workflows/rightsize-with-approval.json', import.meta.url)));

async function setup(over = {}) {
  const calls = { cloud: [], notify: [], sleeps: [] };
  const applied = new Map(); // fake cloud dedupes by idempotency key
  const connectors = {
    simulators: { rightsize: async (input) => ({ action: 'rightsize', resource: input.resource, from: 'm5.4xlarge', to: 'm5.xlarge', estimatedMonthlySavingsUsd: 310, risks: ['brief restart'] }) },
    cloud: { apply: async (plan, { idempotencyKey }) => {
      calls.cloud.push(idempotencyKey);
      if (over.cloudFailTimes && calls.cloud.length <= over.cloudFailTimes) { applied.set(idempotencyKey, true); throw new Error('503 after applying'); }
      applied.set(idempotencyKey, true);
      return { applied: true, effects: applied.size };
    } },
    notify: async (m) => { calls.notify.push(m); return { ok: true }; },
    ...over.connectors,
  };
  const engine = new Engine({ store: over.store ?? new MemoryStore(), connectors, sleep: async (ms) => { calls.sleeps.push(ms); }, credentials: (r) => (r === 'cred/prod' ? 'AKIA-SECRET-123' : undefined) });
  if (!(await engine.store.has('workflowVersions', ORG, 'rightsize-with-approval@1'))) await engine.publish(ORG, workflow);
  return { engine, calls, applied };
}

test('pauses for approval; nothing is applied before a human decides (dry-run only)', async () => {
  const { engine, calls } = await setup();
  const ex = await engine.start(ORG, 'rightsize-with-approval@1', { resource: 'i-123' }, { actor: requester.id });
  assert.equal(ex.status, 'WAITING_APPROVAL');
  assert.equal(calls.cloud.length, 0);
  assert.equal(ex.outputs.plan.dryRun, true);
  assert.equal(ex.steps.find((s) => s.nodeId === 'apply').status, 'PENDING');
});

test('approval resumes and applies exactly once; audit trail is complete', async () => {
  const { engine, calls } = await setup();
  const ex = await engine.start(ORG, 'rightsize-with-approval@1', { resource: 'i-123' }, { actor: requester.id });
  const ap = (await engine.store.list('approvals', ORG))[0];
  const done = await engine.decide(ORG, ap.id, approver, 'approved');
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(calls.cloud.length, 1);
  const actions = (await engine.auditLog(ORG)).map((a) => a.action);
  for (const a of ['workflow.published', 'execution.started', 'approval.requested', 'approval.approved', 'execution.succeeded']) assert.ok(actions.includes(a), a);
  // resuming again must not re-apply
  await engine.resume(ORG, ex.id);
  assert.equal(calls.cloud.length, 1);
});

test('rejection ends the execution and never applies', async () => {
  const { engine, calls } = await setup();
  await engine.start(ORG, 'rightsize-with-approval@1', { resource: 'i-1' }, { actor: requester.id });
  const ap = (await engine.store.list('approvals', ORG))[0];
  const done = await engine.decide(ORG, ap.id, approver, 'rejected');
  assert.equal(done.status, 'REJECTED');
  assert.equal(calls.cloud.length, 0);
  assert.equal(done.steps.find((s) => s.nodeId === 'apply').status, 'SKIPPED');
});

test('approval authorisation: role, tenant, self-approval', async () => {
  const { engine } = await setup();
  await engine.start(ORG, 'rightsize-with-approval@1', { resource: 'i-1' }, { actor: requester.id });
  const ap = (await engine.store.list('approvals', ORG))[0];
  await assert.rejects(engine.decide(ORG, ap.id, requester, 'approved'), /requires role/);
  await assert.rejects(engine.decide(ORG, ap.id, { ...approver, id: requester.id }, 'approved'), /own plan/);
  await assert.rejects(engine.decide(ORG, ap.id, { ...approver, orgId: 'org-b' }, 'approved'), /different organization/);
  await assert.rejects(engine.decide('org-b', ap.id, { ...approver, orgId: 'org-b' }, 'approved'), /unknown approval/);
  assert.equal((await engine.store.get('approvals', ORG, ap.id)).status, 'pending');
});

test('retries with exponential backoff; side effect deduplicated by idempotency key', async () => {
  const { engine, calls, applied } = await setup({ cloudFailTimes: 2 });
  await engine.start(ORG, 'rightsize-with-approval@1', { resource: 'i-1' }, { actor: requester.id });
  const ap = (await engine.store.list('approvals', ORG))[0];
  const done = await engine.decide(ORG, ap.id, approver, 'approved');
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.steps.find((s) => s.nodeId === 'apply').attempts, 3);
  assert.deepEqual(calls.sleeps, [1000, 2000]);
  assert.equal(new Set(calls.cloud).size, 1, 'same idempotency key on every attempt');
  assert.equal(applied.size, 1);
});

test('permanent failure after max attempts marks the execution FAILED', async () => {
  const { engine } = await setup({ cloudFailTimes: 99 });
  await engine.start(ORG, 'rightsize-with-approval@1', { resource: 'i-1' }, { actor: requester.id });
  const ap = (await engine.store.list('approvals', ORG))[0];
  const done = await engine.decide(ORG, ap.id, approver, 'approved');
  assert.equal(done.status, 'FAILED');
});

test('timeout is enforced per step', async () => {
  const { engine } = await setup({ connectors: { notify: () => new Promise(() => {}) } });
  const wf = { id: 't', nodes: [{ id: 'n', type: 'notify', timeoutMs: 20, retry: { maxAttempts: 1 }, params: { message: 'x' } }], edges: [] };
  await engine.publish(ORG, wf);
  const ex = await engine.start(ORG, 't@1', {});
  assert.equal(ex.status, 'FAILED');
  assert.match(ex.steps[0].error, /timeout/);
});

test('recovers after worker restart while waiting for approval', async () => {
  const { engine } = await setup();
  await engine.start(ORG, 'rightsize-with-approval@1', { resource: 'i-1' }, { actor: requester.id });
  const snapshot = engine.store.snapshot();
  const { engine: fresh, calls } = await setup({ store: MemoryStore.restore(snapshot) });
  const ap = (await fresh.store.list('approvals', ORG))[0];
  const done = await fresh.decide(ORG, ap.id, approver, 'approved');
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(calls.cloud.length, 1);
});

test('publish rejects destructive nodes without simulate + approval', async () => {
  const { engine } = await setup();
  const bad = { id: 'bad', nodes: [{ id: 'apply', type: 'apply_plan', params: { planFrom: 'plan' } }], edges: [] };
  await assert.rejects(engine.publish(ORG, bad), /must be preceded by an approval/);
  const noSim = { id: 'bad2', nodes: [{ id: 'ap', type: 'approval', params: { planFrom: 'plan' } }], edges: [] };
  assert.ok(validateDefinition(noSim).length);
  const reordered = structuredClone(workflow);
  reordered.id = 'reordered';
  reordered.edges = [{ from: 'plan', to: 'apply' }, { from: 'apply', to: 'approve' }, { from: 'approve', to: 'done' }];
  assert.ok(validateDefinition(reordered).some((e) => /approval/.test(e)));
});

test('published versions are immutable and cannot be overwritten', async () => {
  const { engine } = await setup();
  const v = await engine.getVersion(ORG, 'rightsize-with-approval@1');
  await assert.rejects(engine.publish(ORG, workflow), /immutable/);
  assert.ok(v.contentHash);
  const live = engine.store.data.workflowVersions[`${ORG}/rightsize-with-approval@1`];
  assert.equal(live.contentHash, v.contentHash);
});

test('destructive step refuses to run if the approved plan differs (hash binding)', async () => {
  const { engine, calls } = await setup();
  const ex = await engine.start(ORG, 'rightsize-with-approval@1', { resource: 'i-1' }, { actor: requester.id });
  const ap = (await engine.store.list('approvals', ORG))[0];
  // tamper: approval was granted for a different plan
  ap.status = 'approved'; ap.planHash = 'deadbeef';
  await engine.store.put('approvals', ORG, ap.id, ap);
  const done = await engine.resume(ORG, ex.id);
  assert.equal(done.status, 'FAILED');
  assert.match(done.steps.find((s) => s.nodeId === 'apply').error, /without an approved decision/);
  assert.equal(calls.cloud.length, 0);
});

test('trigger events are idempotent: same eventId yields the same execution', async () => {
  const { engine } = await setup();
  const a = await engine.start(ORG, 'rightsize-with-approval@1', { resource: 'i-1' }, { eventId: 'anom-42', actor: 'u' });
  const b = await engine.start(ORG, 'rightsize-with-approval@1', { resource: 'i-1' }, { eventId: 'anom-42', actor: 'u' });
  assert.equal(a.id, b.id);
  assert.equal((await engine.store.list('approvals', ORG)).length, 1);
});

test('tenant isolation: other orgs cannot see executions or workflows', async () => {
  const { engine } = await setup();
  const ex = await engine.start(ORG, 'rightsize-with-approval@1', { resource: 'i-1' }, { actor: 'u' });
  assert.equal(await engine.get('org-b', ex.id), undefined);
  assert.equal(await engine.getVersion('org-b', 'rightsize-with-approval@1'), undefined);
  assert.equal((await engine.auditLog('org-b')).length, 0);
});

test('secrets are masked in logs and audit', async () => {
  const leaky = { cloud: { apply: async () => { throw new Error('auth failed for AKIA-SECRET-123'); } } };
  const { engine } = await setup({ connectors: leaky });
  const wf = structuredClone(workflow); wf.id = 'leaky';
  wf.nodes.find((n) => n.id === 'apply').credentialRef = 'cred/prod';
  wf.nodes.find((n) => n.id === 'apply').retry = { maxAttempts: 1 };
  await engine.publish(ORG, wf);
  await engine.start(ORG, 'leaky@1', { resource: 'i' }, { actor: 'u' });
  const ap = (await engine.store.list('approvals', ORG))[0];
  const done = await engine.decide(ORG, ap.id, approver, 'approved');
  assert.equal(done.status, 'FAILED');
  const blob = JSON.stringify([done, await engine.auditLog(ORG)]);
  assert.ok(!blob.includes('AKIA-SECRET-123'));
  assert.deepEqual(redact({ apiKey: 'x', nested: { password: 'y', ok: 1 } }), { apiKey: '***', nested: { password: '***', ok: 1 } });
});

test('AI node output must satisfy the schema; invalid output fails closed', async () => {
  const schema = { type: 'object', required: ['severity'], properties: { severity: { type: 'string', enum: ['low', 'high'] }, summary: { type: 'string', maxLength: 50 } } };
  const mk = async (llm) => {
    const { engine } = await setup({ connectors: { llm } });
    await engine.publish(ORG, { id: 'ai', nodes: [{ id: 'c', type: 'ai_classify', params: { prompt: 'Classify {{input.text}}', schema, maxCalls: 2 } }], edges: [] });
    return engine;
  };
  const good = await (await mk(async () => '{"severity":"high","summary":"ok"}')).start(ORG, 'ai@1', { text: 'x' });
  assert.equal(good.outputs.c.severity, 'high');
  let n = 0;
  const bad = await (await mk(async () => { n += 1; return '{"severity":"drop table","extra":1}'; })).start(ORG, 'ai@1', { text: 'x' });
  assert.equal(bad.status, 'FAILED');
  assert.equal(n, 2, 'call budget respected');
});

test('webhook SSRF guard', async () => {
  const dns = async (h) => (h === 'evil.example.com' ? ['10.0.0.5'] : ['93.184.216.34']);
  const allow = ['hooks.example.com', 'evil.example.com'];
  await assertSafeWebhook('https://hooks.example.com/x', allow, dns);
  await assert.rejects(assertSafeWebhook('http://hooks.example.com/x', allow, dns), /https/);
  await assert.rejects(assertSafeWebhook('https://other.example.com/x', allow, dns), /allowlist/);
  await assert.rejects(assertSafeWebhook('https://evil.example.com/x', allow, dns), /private/);
  await assert.rejects(assertSafeWebhook('https://169.254.169.254/', ['169.254.169.254'], dns), /private/);
  await assert.rejects(assertSafeWebhook('https://[::1]/', ['::1'], dns), /private/);
  await assert.rejects(assertSafeWebhook('https://u:p@hooks.example.com/', allow, dns), /credentials/);
});

test('concurrent in-memory decisions: exactly one wins', async () => {
  const { engine } = await setup();
  await engine.start(ORG, 'rightsize-with-approval@1', { resource: 'i-1' }, { actor: requester.id });
  const [ap] = await engine.store.list('approvals', ORG);
  const r = await Promise.allSettled([engine.decide(ORG, ap.id, approver, 'approved'), engine.decide(ORG, ap.id, { ...approver, id: 'u-9' }, 'approved')]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
});
