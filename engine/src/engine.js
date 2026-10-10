import { randomUUID } from 'node:crypto';
import { assertSafeWebhook, validateSchema } from './guards.js';
import { PermanentError, SafetyError, deepFreeze, hash, redact } from './util.js';

/**
 * Execution states:  RUNNING -> WAITING_APPROVAL -> RUNNING -> SUCCEEDED
 *                    RUNNING -> FAILED | REJECTED
 * Step states:       PENDING -> RUNNING -> SUCCEEDED | FAILED | SKIPPED | WAITING_APPROVAL
 */
export const NODE_TYPES = ['simulate', 'approval', 'apply_plan', 'notify', 'ai_classify', 'webhook', 'task'];
const DESTRUCTIVE = new Set(['apply_plan']);

export class Engine {
  /**
   * @param {object} o
   * @param {MemoryStore} o.store
   * @param {object} o.connectors   { simulators: {name: fn}, cloud: {apply(plan,{idempotencyKey})}, notify(msg), http(url,body), llm(prompt), resolveDns(host), tasks: {name: fn} }
   * @param {(ref:string)=>string} o.credentials  resolves a CredentialReference at run time
   * @param {(ms:number)=>Promise<void>} o.sleep
   */
  constructor({ store, connectors = {}, credentials = () => undefined, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date().toISOString() }) {
    Object.assign(this, { store, connectors, credentials, sleep, now });
  }

  // ---------- definitions ----------
  /** Validates and publishes an immutable, content-hashed workflow version. */
  async publish(orgId, def) {
    const errors = validateDefinition(def);
    if (errors.length) throw new PermanentError(`invalid workflow: ${errors.join('; ')}`);
    const order = chain(def);
    const version = def.version ?? 1;
    const id = `${def.id}@${version}`;
    if (await this.store.has('workflowVersions', orgId, id)) throw new PermanentError(`${id} already published (versions are immutable)`);
    const published = deepFreeze({ ...structuredClone(def), version, order, contentHash: hash(def), publishedAt: this.now() });
    await this.store.put('workflowVersions', orgId, id, published);
    await this.audit(orgId, 'workflow.published', { id });
    return published;
  }

  /** Deterministic execution id for a (workflow, eventId) pair: lets callers know the id before the job runs. */
  executionId(workflowRef, eventId) { return `ex-${hash([workflowRef, eventId]).slice(0, 16)}`; }

  async getVersion(orgId, id) { return await this.store.get('workflowVersions', orgId, id); }

  // ---------- executions ----------
  /** Start (or deduplicate) an execution. `eventId` makes the trigger idempotent. */
  async start(orgId, workflowRef, input = {}, { eventId, actor = 'system' } = {}) {
    const wf = await this.getVersion(orgId, workflowRef);
    if (!wf) throw new PermanentError(`unknown workflow ${workflowRef}`);
    const execId = eventId ? this.executionId(workflowRef, eventId) : `ex-${randomUUID()}`;
    if (await this.store.has('executions', orgId, execId)) return await this.store.get('executions', orgId, execId);
    const exec = {
      id: execId, orgId, workflow: workflowRef, status: 'RUNNING', input, startedBy: actor, createdAt: this.now(),
      steps: wf.order.map((n) => ({ nodeId: n, status: 'PENDING', attempts: 0, logs: [] })), outputs: {},
    };
    await this.save(exec);
    await this.audit(orgId, 'execution.started', { execId, workflowRef, actor });
    return this.resume(orgId, execId);
  }

  async get(orgId, execId) { return await this.store.get('executions', orgId, execId); }

  /** Drives the execution until it finishes or pauses. Safe to call repeatedly (e.g. after a worker restart). */
  async resume(orgId, execId) {
    const exec = await this.get(orgId, execId);
    if (!exec) throw new PermanentError('unknown execution');
    if (['SUCCEEDED', 'FAILED', 'REJECTED'].includes(exec.status)) return exec;
    const wf = await this.getVersion(orgId, exec.workflow);
    exec.status = 'RUNNING';
    for (const step of exec.steps) {
      if (step.status === 'SUCCEEDED' || step.status === 'SKIPPED') continue;
      const node = wf.nodes.find((n) => n.id === step.nodeId);
      const outcome = await this.runStep(exec, step, node, wf);
      await this.save(exec);
      if (outcome === 'PAUSED') { exec.status = 'WAITING_APPROVAL'; await this.save(exec); return exec; }
      if (outcome === 'REJECTED' || outcome === 'FAILED') {
        exec.status = outcome;
        exec.steps.filter((s) => s.status === 'PENDING').forEach((s) => { s.status = 'SKIPPED'; });
        await this.save(exec);
        await this.audit(orgId, `execution.${outcome.toLowerCase()}`, { execId });
        return exec;
      }
    }
    exec.status = 'SUCCEEDED';
    await this.save(exec);
    await this.audit(orgId, 'execution.succeeded', { execId });
    return exec;
  }

  async runStep(exec, step, node, wf) {
    const orgId = exec.orgId;
    const log = (m) => step.logs.push(redact(String(m), this.secrets(node)));

    if (node.type === 'approval') return await this.approvalStep(exec, step, node, log);

    const retry = { maxAttempts: 3, backoffMs: 1000, factor: 2, ...(node.retry ?? {}) };
    step.status = 'RUNNING';
    for (;;) {
      step.attempts += 1;
      try {
        if (DESTRUCTIVE.has(node.type)) await this.assertApproved(exec, node);
        const key = `${exec.id}:${node.id}`;
        const prior = await this.store.get('effects', orgId, key);
        const result = prior !== undefined ? prior.result : await this.withTimeout(
          this.execute(exec, node, { idempotencyKey: key, log }), node.timeoutMs ?? 30000);
        if (prior === undefined) await this.store.put('effects', orgId, key, { result });
        exec.outputs[node.id] = result;
        step.status = 'SUCCEEDED';
        await this.audit(orgId, 'step.succeeded', { execId: exec.id, node: node.id, attempts: step.attempts });
        return 'OK';
      } catch (err) {
        log(`attempt ${step.attempts} failed: ${err.message}`);
        step.error = redact(err.message, this.secrets(node));
        if (err instanceof PermanentError || step.attempts >= retry.maxAttempts) {
          step.status = 'FAILED';
          await this.audit(orgId, 'step.failed', { execId: exec.id, node: node.id, attempts: step.attempts, error: step.error });
          return 'FAILED';
        }
        await this.save(exec); // persist attempt count before waiting: recoverable after a crash
        await this.sleep(retry.backoffMs * retry.factor ** (step.attempts - 1));
      }
    }
  }

  withTimeout(promise, ms) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  secrets(node) {
    return node.credentialRef ? [this.credentials(node.credentialRef)].filter(Boolean) : [];
  }

  async execute(exec, node, { idempotencyKey, log }) {
    const c = this.connectors;
    const p = node.params ?? {};
    switch (node.type) {
      case 'simulate': {
        const sim = c.simulators?.[p.simulator];
        if (!sim) throw new PermanentError(`unknown simulator ${p.simulator}`);
        const plan = await sim(exec.input, p, { orgId: exec.orgId, executionId: exec.id });
        // A plan is data only: dry-run never touches infrastructure.
        return { ...plan, dryRun: true, planHash: hash(plan) };
      }
      case 'apply_plan': {
        const plan = exec.outputs[p.planFrom];
        log(`applying plan ${plan.planHash}`);
        return await c.cloud.apply(plan, { idempotencyKey, credential: node.credentialRef && this.credentials(node.credentialRef) });
      }
      case 'notify': return await c.notify({ execId: exec.id, text: render(p.message, exec) });
      case 'task': {
        const fn = c.tasks?.[p.task];
        if (!fn) throw new PermanentError(`unknown task ${p.task}`);
        return await fn(exec.input, exec.outputs, { idempotencyKey });
      }
      case 'webhook': {
        await assertSafeWebhook(p.url, c.webhookAllowlist ?? [], c.resolveDns ?? (async () => []));
        return await c.http(p.url, { execId: exec.id, idempotencyKey, body: p.body ?? {} });
      }
      case 'ai_classify': {
        if (!c.llm) throw new PermanentError('no LLM connector configured');
        const maxCalls = p.maxCalls ?? 1;
        let last;
        for (let i = 0; i < maxCalls; i += 1) {
          const prompt = render(p.prompt, exec).slice(0, p.maxPromptChars ?? 4000);
          const raw = await c.llm(prompt);
          if (raw.length > (p.maxOutputChars ?? 2000)) throw new PermanentError('AI output exceeds size cap');
          let parsed;
          try { parsed = JSON.parse(raw); } catch { last = ['not valid JSON']; continue; }
          last = validateSchema(parsed, p.schema);
          if (!last.length) return parsed;
        }
        throw new PermanentError(`AI output rejected: ${last.join(', ')}`);
      }
      default: throw new PermanentError(`unsupported node type ${node.type}`);
    }
  }

  // ---------- approvals ----------
  async approvalStep(exec, step, node, log) {
    const orgId = exec.orgId;
    const existing = (await this.store.list('approvals', orgId)).find((a) => a.executionId === exec.id && a.nodeId === node.id);
    if (!existing) {
      const plan = exec.outputs[node.params.planFrom];
      if (!plan?.planHash) throw new SafetyError('approval requires a simulated plan');
      const a = {
        id: `ap-${randomUUID()}`, orgId, executionId: exec.id, nodeId: node.id, status: 'pending', plan, planHash: plan.planHash,
        requiredRole: node.params.requiredRole ?? 'approver', allowSelfApproval: node.params.allowSelfApproval ?? false,
        requestedBy: exec.startedBy, requestedAt: this.now(),
      };
      await this.store.put('approvals', orgId, a.id, a);
      step.status = 'WAITING_APPROVAL';
      await this.audit(orgId, 'approval.requested', { approvalId: a.id, execId: exec.id, planHash: a.planHash });
      log(`waiting for approval ${a.id}`);
      return 'PAUSED';
    }
    if (existing.status === 'pending') { step.status = 'WAITING_APPROVAL'; return 'PAUSED'; }
    if (existing.status === 'rejected') { step.status = 'FAILED'; step.error = 'rejected by approver'; return 'REJECTED'; }
    step.status = 'SUCCEEDED';
    exec.outputs[node.id] = { approvalId: existing.id, planHash: existing.planHash };
    return 'OK';
  }

  /** Records the human decision. Roles, tenant and separation of duties are enforced here. */
  async decide(orgId, approvalId, user, decision, comment = '', { defer = false } = {}) {
    if (!['approved', 'rejected'].includes(decision)) throw new PermanentError('decision must be approved|rejected');
    // Check-and-set inside one atomic update so two concurrent decisions cannot both win.
    const a = await this.store.update('approvals', orgId, approvalId, (cur) => {
      if (!cur) throw new PermanentError('unknown approval'); // also hit for other tenants' ids
      if (cur.status !== 'pending') throw new PermanentError(`approval already ${cur.status}`);
      if (user.orgId !== orgId) throw new SafetyError('user belongs to a different organization');
      if (!user.roles?.includes(cur.requiredRole)) throw new SafetyError(`requires role ${cur.requiredRole}`);
      if (!cur.allowSelfApproval && user.id === cur.requestedBy) throw new SafetyError('requester cannot approve their own plan');
      return { ...cur, status: decision, decidedBy: user.id, decidedAt: this.now(), comment };
    });
    await this.audit(orgId, `approval.${decision}`, { approvalId, by: user.id, planHash: a.planHash });
    return defer ? a : this.resume(orgId, a.executionId);
  }

  /** Last line of defence: a destructive node only runs with an approved decision bound to the exact plan hash. */
  async assertApproved(exec, node) {
    const plan = exec.outputs[node.params.planFrom];
    const ok = (await this.store.list('approvals', exec.orgId)).find((a) =>
      a.executionId === exec.id && a.status === 'approved' && a.planHash === plan?.planHash);
    if (!ok) throw new SafetyError('destructive step without an approved decision for this exact plan');
  }

  // ---------- plumbing ----------
  async save(exec) { await this.store.put('executions', exec.orgId, exec.id, exec); }
  async audit(orgId, action, detail) {
    const id = `${this.now()}-${randomUUID().slice(0, 8)}`;
    await this.store.put('audit', orgId, id, { id, orgId, action, detail: redact(detail), at: this.now() });
  }
  async auditLog(orgId) { return this.store.list('audit', orgId); }
}

function render(tpl, exec) {
  return String(tpl ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = path.split('.').reduce((o, k) => o?.[k], { input: exec.input, outputs: exec.outputs });
    return typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
  });
}

/** Definition must be a single linear chain (no cycles/branches). */
function chain(def) {
  const next = new Map(def.edges.map((e) => [e.from, e.to]));
  const targets = new Set(def.edges.map((e) => e.to));
  const start = def.nodes.find((n) => !targets.has(n.id))?.id;
  const order = [];
  for (let n = start; n; n = next.get(n)) order.push(n);
  return order;
}

export function validateDefinition(def) {
  const errs = [];
  if (!def?.id || !Array.isArray(def.nodes) || !Array.isArray(def.edges)) return ['id, nodes and edges are required'];
  const ids = def.nodes.map((n) => n.id);
  if (new Set(ids).size !== ids.length) errs.push('duplicate node ids');
  for (const n of def.nodes) if (!NODE_TYPES.includes(n.type)) errs.push(`node ${n.id}: unknown type ${n.type}`);
  const from = def.edges.map((e) => e.from);
  const to = def.edges.map((e) => e.to);
  if (new Set(from).size !== from.length || new Set(to).size !== to.length) errs.push('branching is not supported: one edge in/out per node');
  if (def.edges.some((e) => !ids.includes(e.from) || !ids.includes(e.to))) errs.push('edge references unknown node');
  if (errs.length) return errs;
  const order = chain(def);
  if (order.length !== ids.length) errs.push('nodes must form one connected acyclic chain');
  if (errs.length) return errs;
  const byId = Object.fromEntries(def.nodes.map((n) => [n.id, n]));
  order.forEach((id, i) => {
    const n = byId[id];
    const before = order.slice(0, i).map((x) => byId[x]);
    if (DESTRUCTIVE.has(n.type)) {
      const ap = before.find((b) => b.type === 'approval' && b.params?.planFrom === n.params?.planFrom);
      if (!ap) errs.push(`destructive node ${id} must be preceded by an approval node for the same plan`);
      const sim = before.find((b) => b.type === 'simulate' && b.id === n.params?.planFrom);
      if (!sim) errs.push(`destructive node ${id} must apply the output of a preceding simulate node`);
    }
    if (n.type === 'approval' && !before.some((b) => b.type === 'simulate' && b.id === n.params?.planFrom)) {
      errs.push(`approval ${id} must reference a preceding simulate node (params.planFrom)`);
    }
  });
  return errs;
}
