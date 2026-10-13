import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Recommendation } from './plans';

const GROUPS: Record<string, string> = {
  service: 'service', account: 'account_id', project: 'project', region: 'region', environment: 'environment',
  currency: 'currency', untagged: 'untagged',
};

export async function summary(store: any, orgId: string, groupBy: string, from?: string, to?: string) {
  const col = GROUPS[groupBy];
  if (!col) throw new BadRequestException(`group_by must be one of ${Object.keys(GROUPS).join(', ')}`);
  const r = await store.tx(orgId, (c: any) => c.query(
    `SELECT ${col}::text AS grp, sum(cost_base)::text AS total, count(*)::int AS record_count,
            array_agg(record_id ORDER BY record_id) AS record_ids, array_agg(source_line ORDER BY record_id) AS source_lines
       FROM cost_records WHERE org_id=$1 AND ($2::date IS NULL OR usage_date>=$2) AND ($3::date IS NULL OR usage_date<=$3)
      GROUP BY 1 ORDER BY sum(cost_base) DESC`, [orgId, from ?? null, to ?? null]));
  return { group_by: groupBy, groups: r.rows.map((x: any) => ({ group: x.grp, total: x.total, record_count: x.record_count, record_ids: x.record_ids, source_lines: x.source_lines })) };
}

export async function dailySeries(store: any, orgId: string, key = 'service') {
  const col = GROUPS[key];
  if (!col || key === 'untagged') throw new BadRequestException('unsupported series key');
  const r = await store.tx(orgId, (c: any) => c.query(
    `SELECT ${col}::text AS k, to_char(usage_date,'YYYY-MM-DD') AS d, sum(cost_base)::float8 AS v
       FROM cost_records WHERE org_id=$1 GROUP BY 1,2 ORDER BY 2`, [orgId]));
  const series: Record<string, Record<string, number>> = {};
  for (const x of r.rows) (series[x.k] ??= {})[x.d] = x.v;
  return series;
}

/** Heuristic: untagged resources with no project/environment. Evidence lists the source records. */
export async function listRecommendations(store: any, orgId: string): Promise<Recommendation[]> {
  const r = await store.tx(orgId, (c: any) => c.query(
    `SELECT resource_id, min(service) AS service, min(region) AS region, count(*)::int AS n,
            to_char(min(usage_date),'YYYY-MM-DD') AS first, to_char(max(usage_date),'YYYY-MM-DD') AS last,
            count(DISTINCT usage_date)::int AS days, sum(cost_base)::float8 AS total,
            (array_agg(record_id ORDER BY usage_date))[1:3] AS sample
       FROM cost_records
      WHERE org_id=$1 AND untagged AND resource_id <> '' AND project='unassigned' AND environment='unknown'
      GROUP BY resource_id ORDER BY sum(cost_base) DESC`, [orgId]));
  return r.rows.map((x: any) => ({
    id: 'rec-' + createHash('sha256').update(`${orgId}|${x.resource_id}`).digest('hex').slice(0, 12),
    kind: 'delete_orphan' as const, resource_id: x.resource_id, service: x.service, region: x.region,
    monthly_savings_usd: Math.round((x.total / x.days) * 30 * 100) / 100, days_observed: x.days,
    evidence: { record_count: x.n, first_date: x.first, last_date: x.last, sample_record_ids: x.sample },
    rationale: `Resource has no owner tag, no project and no environment, and has cost money on ${x.days} days.`,
  }));
}

// ---------------- cost model: budgets, allocation, persisted anomalies and forecasts ----------------

const SCOPE_COL: Record<string, string> = { project: 'project', service: 'service', environment: 'environment' };
export const SCOPE_TYPES = ['total', 'project', 'service', 'environment'];

export const budgetId = (month: string, scopeType: string, scopeValue: string) => `${month}|${scopeType}|${scopeValue}`;

/** Daily cost (USD base) inside a budget scope. The column comes from a fixed map, never from user input. */
export async function scopedSeries(store: any, orgId: string, scopeType: string, scopeValue: string): Promise<Record<string, number>> {
  if (!SCOPE_TYPES.includes(scopeType)) throw new BadRequestException('invalid scope_type');
  const filter = scopeType === 'total' ? '' : `AND ${SCOPE_COL[scopeType]} = $2`;
  const params = scopeType === 'total' ? [orgId] : [orgId, scopeValue];
  const r = await store.tx(orgId, (c: any) => c.query(
    `SELECT to_char(usage_date,'YYYY-MM-DD') AS d, sum(cost_base)::float8 AS v FROM cost_records
      WHERE org_id=$1 ${filter} GROUP BY 1 ORDER BY 1`, params));
  return Object.fromEntries(r.rows.map((x: any) => [x.d, x.v]));
}

export async function upsertBudget(store: any, orgId: string, b: { month: string; amount: number; scope_type: string; scope_value: string; thresholds: number[] }) {
  await store.pool.query('INSERT INTO organizations (id, name) VALUES ($1,$1) ON CONFLICT DO NOTHING', [orgId]);
  const id = budgetId(b.month, b.scope_type, b.scope_value);
  await store.tx(orgId, (c: any) => c.query(
    `INSERT INTO budgets (org_id,id,name,month,amount,scope_type,scope_value,thresholds) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (org_id,id) DO UPDATE SET amount=EXCLUDED.amount, thresholds=EXCLUDED.thresholds`,
    [orgId, id, b.scope_value || 'total', b.month, b.amount, b.scope_type, b.scope_value, b.thresholds]));
  return { id, ...b };
}

export async function listBudgets(store: any, orgId: string, month?: string) {
  const r = await store.tx(orgId, (c: any) => c.query(
    `SELECT id, month, amount::float8 AS amount, scope_type, scope_value, thresholds FROM budgets
      WHERE org_id=$1 AND ($2::text IS NULL OR month=$2) ORDER BY month, scope_type, scope_value`, [orgId, month ?? null]));
  return r.rows.map((x: any) => ({ ...x, thresholds: (x.thresholds ?? []).map(Number) }));
}

/** Showback: cost per owner/project. Anything without an owner tag (or with project "unassigned") is "unallocated". */
export async function allocation(store: any, orgId: string, by: string, from?: string, to?: string) {
  const expr = by === 'owner' ? "coalesce(nullif(tags->>'owner',''),'unallocated')"
    : by === 'project' ? "CASE WHEN project='unassigned' THEN 'unallocated' ELSE project END" : null;
  if (!expr) throw new BadRequestException('by must be owner or project');
  const r = await store.tx(orgId, (c: any) => c.query(
    `SELECT ${expr} AS grp, sum(cost_base)::text AS total, count(*)::int AS record_count,
            array_agg(record_id ORDER BY record_id) AS record_ids
       FROM cost_records WHERE org_id=$1 AND ($2::date IS NULL OR usage_date>=$2) AND ($3::date IS NULL OR usage_date<=$3)
      GROUP BY 1 ORDER BY sum(cost_base) DESC`, [orgId, from ?? null, to ?? null]));
  const groups = r.rows.map((x: any) => ({ group: x.grp, total: x.total, record_count: x.record_count, record_ids: x.record_ids }));
  const total = groups.reduce((a: number, g: any) => a + Number(g.total), 0);
  const unalloc = Number(groups.find((g: any) => g.group === 'unallocated')?.total ?? 0);
  return {
    by, total: total.toFixed(4), unallocated_total: unalloc.toFixed(4),
    coverage_pct: total === 0 ? null : Math.round((1000 * (total - unalloc)) / total) / 10, groups,
  };
}

const numRow = (x: any) => ({
  id: x.id, series_key: x.series_key, series: x.series, date: x.d, observed: Number(x.observed), expected: Number(x.expected),
  delta: Number(x.delta), robust_z: Number(x.robust_z), direction: x.direction, explanation: x.explanation, method: x.method,
  status: x.status, acknowledged_by: x.acknowledged_by, detected_at: x.detected_at,
});

/** Upserts detected anomalies (stable id per series/date); an acknowledged anomaly stays acknowledged on re-detection. */
export async function persistAnomalies(store: any, orgId: string, seriesKey: string, found: any[]) {
  await store.tx(orgId, async (c: any) => {
    for (const a of found) {
      const id = 'an-' + createHash('sha256').update(`${orgId}|${seriesKey}|${a.series}|${a.date}`).digest('hex').slice(0, 12);
      await c.query(
        `INSERT INTO anomalies (org_id,id,series_key,series,usage_date,observed,expected,delta,robust_z,direction,explanation,method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (org_id,id) DO UPDATE SET observed=EXCLUDED.observed, expected=EXCLUDED.expected, delta=EXCLUDED.delta,
           robust_z=EXCLUDED.robust_z, explanation=EXCLUDED.explanation, method=EXCLUDED.method`,
        [orgId, id, seriesKey, a.series, a.date, a.observed, a.expected, a.delta, a.robust_z, a.direction, a.explanation, JSON.stringify(a.method)]);
    }
  });
}

export async function listAnomalies(store: any, orgId: string, seriesKey: string, status?: string) {
  const r = await store.tx(orgId, (c: any) => c.query(
    `SELECT id, series_key, series, to_char(usage_date,'YYYY-MM-DD') AS d, observed, expected, delta, robust_z, direction, explanation,
            method, status, acknowledged_by, detected_at
       FROM anomalies WHERE org_id=$1 AND series_key=$2 AND ($3::text IS NULL OR status=$3) ORDER BY usage_date, series`,
    [orgId, seriesKey, status ?? null]));
  return r.rows.map(numRow);
}

export async function acknowledgeAnomaly(store: any, orgId: string, id: string, user: string) {
  const r = await store.tx(orgId, (c: any) => c.query(
    "UPDATE anomalies SET status='acknowledged', acknowledged_by=$3 WHERE org_id=$1 AND id=$2 RETURNING id", [orgId, id, user]));
  return r.rowCount === 1;
}

export async function saveForecast(store: any, orgId: string, f: any, user: string) {
  const id = 'fc-' + createHash('sha256').update(`${orgId}|${f.as_of}|${f.point_estimate}|${f.budget ?? ''}`).digest('hex').slice(0, 12);
  await store.tx(orgId, (c: any) => c.query(
    `INSERT INTO forecast_snapshots (org_id,id,as_of,month,point,interval_80,interval_95,method,assumptions,budget,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (org_id,id) DO NOTHING`,
    [orgId, id, f.as_of, f.month, f.point_estimate, JSON.stringify(f.interval_80), JSON.stringify(f.interval_95),
      JSON.stringify(f.method), JSON.stringify(f.assumptions), f.budget ?? null, user]));
  return id;
}

export async function listForecasts(store: any, orgId: string, limit = 20) {
  const r = await store.tx(orgId, (c: any) => c.query(
    `SELECT id, to_char(as_of,'YYYY-MM-DD') AS as_of, month, point::float8 AS point_estimate, interval_80, interval_95, method, assumptions,
            budget::float8 AS budget, created_by, created_at FROM forecast_snapshots WHERE org_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [orgId, Math.min(Math.max(limit, 1), 100)]));
  return r.rows;
}
