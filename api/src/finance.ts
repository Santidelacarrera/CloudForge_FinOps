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
