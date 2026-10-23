import {
  BadRequestException, Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, Post, Put, Query, Req,
  Inject, Catch, ExceptionFilter, ArgumentsHost, HttpException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthUser, Roles } from './auth';
import { CoreService } from './core.service';
import { buildDeletePlan } from './plans';
import {
  SCOPE_TYPES, acknowledgeAnomaly, allocation, budgetId, dailySeries, listAnomalies, listBudgets, listForecasts,
  persistAnomalies, saveForecast, scopedSeries, summary, upsertBudget,
} from './finance';

const { PermanentError, SafetyError, hash } = require('@cloudforge/engine');

type Req_ = { user: AuthUser };
function matches(filter: any, a: any): boolean {
  if (!filter) return true;
  if (filter.series && filter.series !== a.series) return false;
  if (typeof filter.minDelta === 'number' && Math.abs(a.delta) < filter.minDelta) return false;
  if (filter.direction && filter.direction !== a.direction) return false;
  return true;
}
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Maps engine errors to HTTP statuses so SafetyError (e.g. unauthorised approver) is a 403, not a 500. */
@Catch()
export class EngineErrorFilter implements ExceptionFilter {
  catch(err: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (err instanceof HttpException) return res.status(err.getStatus()).json(err.getResponse());
    if (err instanceof SafetyError) return res.status(403).json({ statusCode: 403, message: err.message });
    if (err instanceof PermanentError) {
      const status = /unknown/.test(err.message) ? 404 : 400;
      return res.status(status).json({ statusCode: status, message: err.message });
    }
    console.error(err);
    return res.status(500).json({ statusCode: 500, message: 'internal error' });
  }
}

@Controller('api/v1')
export class AppController {
  constructor(@Inject(CoreService) private core: CoreService) {}

  private async analytics(path: string, body: unknown) {
    const r = await fetch(`${this.core.analyticsUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const json: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new BadRequestException(json.detail ?? 'analytics service error');
    return json;
  }

  /** Detects anomalies, persists them as entities and returns the stored rows (status preserved across re-detection). */
  private async detectAnomalies(orgId: string, key = 'service', status?: string) {
    const series = await dailySeries(this.core.store, orgId, key);
    await persistAnomalies(this.core.store, orgId, key, await this.analytics('/v1/anomalies', { series }));
    return listAnomalies(this.core.store, orgId, key, status);
  }

  /** Status of every budget of a month: month-to-date, explainable projection and crossed thresholds. */
  private async budgetStatuses(orgId: string, month?: string, asOf?: string) {
    const out: any[] = [];
    for (const b of await listBudgets(this.core.store, orgId, month)) {
      const series = await scopedSeries(this.core.store, orgId, b.scope_type, b.scope_value);
      const inMonth = Object.keys(series).filter((d) => d.startsWith(b.month)).sort();
      if (!inMonth.length) { out.push({ ...b, status: 'no_data' }); continue; }
      const as_of = asOf && asOf.startsWith(b.month) ? asOf : inMonth[inMonth.length - 1];
      try {
        const r = await this.analytics('/v1/budget-status', { series, amount: b.amount, as_of, thresholds: b.thresholds });
        out.push({ ...b, ...r });
      } catch (e) {
        if (!(e instanceof BadRequestException)) throw e;
        out.push({ ...b, status: 'insufficient_data', as_of });
      }
    }
    return out;
  }

  /**
   * Starts workflows whose trigger matches.
   *  - `anomaly.detected` (filter: series, minDelta, direction): eventId = anomaly:<series>:<date>
   *  - `budget.threshold` (filter: scope_type, scope_value, minThreshold, default 0.8): eventId = budget:<budget id>:<threshold>
   * Event ids are deterministic, so re-importing or re-evaluating never starts a second execution.
   */
  private async evaluateTriggers(orgId: string, actor: string) {
    const latest = new Map<string, any>();
    for (const w of await this.core.store.list('workflowVersions', orgId)) {
      if (!latest.has(w.id) || latest.get(w.id).version < w.version) latest.set(w.id, w);
    }
    const started: { executionId: string; workflow: string; anomaly?: string; event: string }[] = [];
    const fire = async (w: any, eventId: string, input: any) => {
      const ref = `${w.id}@${w.version}`;
      await this.core.startExecution(orgId, ref, input, { eventId, actor: `trigger:${w.id}` });
      started.push({ executionId: this.core.engine.executionId(ref, eventId), workflow: ref, anomaly: eventId, event: eventId });
    };
    const wanted = (type: string) => [...latest.values()].filter((w) => w.trigger?.type === type);

    if (wanted('anomaly.detected').length) {
      const anomalies = await this.detectAnomalies(orgId, 'service', 'open');
      for (const w of wanted('anomaly.detected')) {
        for (const a of anomalies.filter((x: any) => matches(w.trigger.filter, x))) {
          await fire(w, `anomaly:${a.series}:${a.date}`, { anomaly: a, series: a.series, date: a.date, delta: a.delta });
        }
      }
    }
    if (wanted('budget.threshold').length) {
      const statuses = await this.budgetStatuses(orgId);
      for (const w of wanted('budget.threshold')) {
        const f = w.trigger.filter ?? {};
        const min = typeof f.minThreshold === 'number' ? f.minThreshold : 0.8;
        for (const s of statuses) {
          if (!s.events || (f.scope_type && f.scope_type !== s.scope_type) || (f.scope_value && f.scope_value !== s.scope_value)) continue;
          for (const ev of s.events.filter((e: any) => e.threshold >= min)) {
            await fire(w, `budget:${s.id}:${ev.threshold}`, { budget: { id: s.id, scope_type: s.scope_type, scope_value: s.scope_value, month: s.month, amount: s.amount },
              threshold: ev.threshold, pct: ev.pct, spent: ev.spent, status: s.status, projected: s.projected });
          }
        }
      }
    }
    return started;
  }

  @Post('triggers/evaluate') @Roles('operator') @HttpCode(200)
  evaluate(@Req() req: Req_) { return this.evaluateTriggers(req.user.orgId, req.user.id); }

  // ---------- ingestion ----------
  @Post('cost-imports') @Roles('analyst')
  async importCosts(@Req() req: Req_, @Body() b: { name?: string; csv?: string; rates?: Record<string, number>; base_currency?: string }) {
    if (typeof b.csv !== 'string' || !b.csv) throw new BadRequestException('csv is required');
    const out = await this.analytics('/v1/ingest', { csv: b.csv, rates: b.rates ?? {}, base_currency: b.base_currency ?? 'USD' });
    const orgId = req.user.orgId;
    const importId = `imp-${randomUUID().slice(0, 12)}`;
    // Org rows are provisioned lazily from the (trusted) token issuer.
    await this.core.store.pool.query('INSERT INTO organizations (id, name) VALUES ($1,$1) ON CONFLICT DO NOTHING', [orgId]);
    const inserted = await this.core.store.tx(orgId, async (c: any) => {
      await c.query('INSERT INTO cost_imports (org_id,id,source_name,rejected,duplicates,base_currency) VALUES ($1,$2,$3,$4,$5,$6)',
        [orgId, importId, b.name ?? 'upload.csv', JSON.stringify(out.rejected), JSON.stringify(out.duplicates), out.base_currency]);
      const r = await c.query(
        `INSERT INTO cost_records (org_id,import_id,record_id,usage_date,account_id,project,service,region,environment,resource_id,cost,currency,cost_base,untagged,tags,source_line)
         SELECT $1,$2,x.record_id,x.date::date,x.account_id,x.project,x.service,x.region,x.environment,x.resource_id,x.cost::numeric,x.currency,x.cost_base::numeric,x.untagged,x.tags,x.source_line
           FROM jsonb_to_recordset($3::jsonb) AS x(record_id text,date text,account_id text,project text,service text,region text,environment text,resource_id text,cost text,currency text,cost_base text,untagged boolean,tags jsonb,source_line int)
         ON CONFLICT (org_id, record_id) DO NOTHING`, [orgId, importId, JSON.stringify(out.records)]);
      return r.rowCount as number;
    });
    const triggered = inserted > 0 ? await this.evaluateTriggers(orgId, req.user.id) : [];
    return { importId, received: out.records.length, inserted, already_present: out.records.length - inserted, rejected: out.rejected, duplicates: out.duplicates, triggered };
  }

  /** Pulls billing from the configured provider with the READ-ONLY credential and imports it like any CSV. */
  @Post('connectors/sync') @Roles('analyst')
  async sync(@Req() req: Req_, @Body() b: { from?: string; to?: string; rates?: Record<string, number> }) {
    if (!this.core.provider) throw new BadRequestException('no provider configured (set PROVIDER_URL)');
    if ((b?.from && !DATE.test(b.from)) || (b?.to && !DATE.test(b.to))) throw new BadRequestException('from/to must be YYYY-MM-DD');
    const csv = await this.core.provider.billingCsv(b?.from, b?.to);
    return this.importCosts(req, { name: 'provider-sync', csv, rates: b?.rates ?? {} });
  }

  // ---------- analytics ----------
  @Get('costs/summary')
  costsSummary(@Req() req: Req_, @Query('group_by') g = 'service', @Query('from') from?: string, @Query('to') to?: string) {
    if ((from && !DATE.test(from)) || (to && !DATE.test(to))) throw new BadRequestException('from/to must be YYYY-MM-DD');
    return summary(this.core.store, req.user.orgId, g, from, to);
  }

  @Get('anomalies')
  anomalies(@Req() req: Req_, @Query('key') key = 'service', @Query('status') status?: string) {
    if (status && !['open', 'acknowledged'].includes(status)) throw new BadRequestException('status must be open|acknowledged');
    return this.detectAnomalies(req.user.orgId, key, status);
  }

  @Post('anomalies/:id/ack') @Roles('analyst') @HttpCode(200)
  async ackAnomaly(@Req() req: Req_, @Param('id') id: string) {
    if (!(await acknowledgeAnomaly(this.core.store, req.user.orgId, id, req.user.id))) throw new NotFoundException('unknown anomaly');
    return { id, status: 'acknowledged' };
  }

  /** Create or update a budget. Scope: total (default) or one project/service/environment. */
  @Put('budgets/:month') @Roles('analyst')
  async setBudget(@Req() req: Req_, @Param('month') month: string,
    @Body() b: { amount?: number; scope_type?: string; scope_value?: string; thresholds?: number[] }) {
    const scope_type = b?.scope_type ?? 'total';
    const scope_value = scope_type === 'total' ? '' : String(b?.scope_value ?? '');
    const thresholds = b?.thresholds ?? [0.5, 0.8, 1];
    if (!MONTH.test(month) || !(typeof b?.amount === 'number' && Number.isFinite(b.amount) && b.amount > 0)) throw new BadRequestException('month=YYYY-MM and positive amount required');
    if (!SCOPE_TYPES.includes(scope_type)) throw new BadRequestException(`scope_type must be one of ${SCOPE_TYPES.join(', ')}`);
    if (scope_type !== 'total' && (!scope_value || scope_value.length > 100)) throw new BadRequestException('scope_value is required (max 100 chars) for a scoped budget');
    if (!Array.isArray(thresholds) || thresholds.length > 10 || thresholds.some((t) => typeof t !== 'number' || !(t > 0 && t <= 10))) throw new BadRequestException('thresholds must be up to 10 numbers in (0, 10]');
    await upsertBudget(this.core.store, req.user.orgId, { month, amount: b.amount, scope_type, scope_value, thresholds });
    return { id: budgetId(month, scope_type, scope_value), month, amount: b.amount, scope_type, scope_value, thresholds };
  }

  @Get('budgets/status')
  budgetStatus(@Req() req: Req_, @Query('month') month?: string, @Query('as_of') asOf?: string) {
    if ((month && !MONTH.test(month)) || (asOf && !DATE.test(asOf))) throw new BadRequestException('month=YYYY-MM, as_of=YYYY-MM-DD');
    return this.budgetStatuses(req.user.orgId, month, asOf);
  }

  /** Showback by owner/project with tag-coverage: how much of the spend can be attributed to someone. */
  @Get('costs/allocation')
  costsAllocation(@Req() req: Req_, @Query('by') by = 'owner', @Query('from') from?: string, @Query('to') to?: string) {
    if ((from && !DATE.test(from)) || (to && !DATE.test(to))) throw new BadRequestException('from/to must be YYYY-MM-DD');
    return allocation(this.core.store, req.user.orgId, by, from, to);
  }

  @Get('costs/variance')
  async costsVariance(@Req() req: Req_, @Query('as_of') asOf?: string) {
    const series = await dailySeries(this.core.store, req.user.orgId, 'service');
    const days = Object.values(series).flatMap((s) => Object.keys(s)).sort();
    if (!days.length) throw new BadRequestException('no cost data imported');
    const as_of = asOf ?? days[days.length - 1];
    if (!DATE.test(as_of)) throw new BadRequestException('as_of must be YYYY-MM-DD');
    return this.analytics('/v1/variance', { series, as_of });
  }

  /** Every forecast is stored with its method, interval and assumptions. */
  @Get('forecasts')
  async forecasts(@Req() req: Req_, @Query('as_of') asOf?: string, @Query('budget') budget?: string) {
    const series = await dailySeries(this.core.store, req.user.orgId, 'service');
    const total: Record<string, number> = {};
    for (const s of Object.values(series)) for (const [d, v] of Object.entries(s)) total[d] = (total[d] ?? 0) + v;
    const days = Object.keys(total).sort();
    if (!days.length) throw new BadRequestException('no cost data imported');
    const as_of = asOf ?? days[days.length - 1];
    if (!DATE.test(as_of)) throw new BadRequestException('as_of must be YYYY-MM-DD');
    let b = budget ? Number(budget) : undefined;
    if (b !== undefined && !(b > 0)) throw new BadRequestException('budget must be positive');
    if (b === undefined) {
      const r = await this.core.store.tx(req.user.orgId, (c: any) => c.query(
        "SELECT amount::float8 a FROM budgets WHERE org_id=$1 AND month=$2 AND scope_type='total'", [req.user.orgId, as_of.slice(0, 7)]));
      b = r.rows[0]?.a;
    }
    const f = await this.analytics('/v1/forecast', { series: total, as_of, budget: b });
    return { ...f, id: await saveForecast(this.core.store, req.user.orgId, f, req.user.id) };
  }

  @Get('forecasts/history')
  forecastHistory(@Req() req: Req_, @Query('limit') limit = '20') { return listForecasts(this.core.store, req.user.orgId, Number(limit) || 20); }

  // ---------- recommendations & simulation ----------
  @Get('recommendations')
  recommendations(@Req() req: Req_) { return this.core.recommendations(req.user.orgId); }

  /** Dry-run: produces and stores a plan. Has no connector to any cloud API. */
  @Post('recommendations/:id/simulate') @Roles('analyst', 'operator') @HttpCode(200)
  async simulate(@Req() req: Req_, @Param('id') id: string) {
    const rec = (await this.core.recommendations(req.user.orgId)).find((r) => r.id === id);
    if (!rec) throw new NotFoundException('unknown recommendation');
    const base = buildDeletePlan(rec);
    const planHash = hash(base); // same hashing as the engine's simulate node
    const doc = { id: `plan-${planHash.slice(0, 12)}`, planHash, createdBy: req.user.id, plan: { ...base, dryRun: true } };
    await this.core.store.put('plans', req.user.orgId, doc.id, doc);
    return doc;
  }

  // ---------- workflows ----------
  @Post('workflows') @Roles('operator')
  async createWorkflow(@Req() req: Req_, @Body() def: any) {
    if (!def?.id || typeof def.id !== 'string') throw new BadRequestException('workflow id is required');
    const existing = (await this.core.store.list('workflowVersions', req.user.orgId)).filter((w: any) => w.id === def.id);
    const version = existing.reduce((m: number, w: any) => Math.max(m, w.version), 0) + 1;
    const pub = await this.core.engine.publish(req.user.orgId, { ...def, version });
    return { ref: `${pub.id}@${pub.version}`, version: pub.version, contentHash: pub.contentHash, order: pub.order };
  }

  @Get('workflows')
  async listWorkflows(@Req() req: Req_) {
    return (await this.core.store.list('workflowVersions', req.user.orgId)).map((w: any) => ({ ref: `${w.id}@${w.version}`, name: w.name, nodes: w.nodes.length, contentHash: w.contentHash }));
  }

  @Post('workflows/:id/run') @Roles('operator') @HttpCode(202)
  async run(@Req() req: Req_, @Param('id') id: string, @Body() b: { input?: any }, @Headers('idempotency-key') idem?: string) {
    let ref = id;
    if (!id.includes('@')) {
      const versions = (await this.core.store.list('workflowVersions', req.user.orgId)).filter((w: any) => w.id === id);
      if (!versions.length) throw new NotFoundException('unknown workflow');
      ref = `${id}@${Math.max(...versions.map((w: any) => w.version))}`;
    }
    if (!(await this.core.engine.getVersion(req.user.orgId, ref))) throw new NotFoundException('unknown workflow');
    const eventId = idem ?? randomUUID();
    await this.core.startExecution(req.user.orgId, ref, b?.input ?? {}, { eventId, actor: req.user.id });
    return { executionId: this.core.engine.executionId(ref, eventId), workflow: ref };
  }

  // ---------- executions & approvals ----------
  @Get('executions')
  async listExecutions(@Req() req: Req_) {
    return (await this.core.store.list('executions', req.user.orgId)).map((e: any) => ({ id: e.id, workflow: e.workflow, status: e.status, createdAt: e.createdAt }));
  }

  @Get('executions/:id')
  async execution(@Req() req: Req_, @Param('id') id: string) {
    const e = await this.core.engine.get(req.user.orgId, id);
    if (!e) throw new NotFoundException('unknown execution');
    return e;
  }

  @Get('approvals')
  async approvals(@Req() req: Req_, @Query('status') status?: string) {
    const all = await this.core.store.list('approvals', req.user.orgId);
    return status ? all.filter((a: any) => a.status === status) : all;
  }

  /** The engine enforces role, tenant and separation of duties; the resume runs on the worker. */
  @Post('approvals/:id/decision') @HttpCode(200)
  async decide(@Req() req: Req_, @Param('id') id: string, @Body() b: { decision?: string; comment?: string }) {
    if (b?.decision !== 'approved' && b?.decision !== 'rejected') throw new BadRequestException('decision must be approved|rejected');
    const a = await this.core.engine.decide(req.user.orgId, id, req.user, b.decision, String(b.comment ?? '').slice(0, 1000), { defer: true });
    await this.core.resumeExecution(req.user.orgId, a.executionId);
    return { approvalId: a.id, status: a.status, executionId: a.executionId };
  }

  @Get('healthz') @Roles()
  health() { return { ok: true }; }
}
