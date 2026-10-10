import { createHash } from 'node:crypto';
import type { CloudProvider } from './provider';
import type { Recommendation } from './plans';
const { PermanentError } = require('@cloudforge/engine');

export interface CloudflareOptions {
  accountId: string; readToken: string;
  baseUrl?: string;            // default https://api.cloudflare.com/client/v4
  kvEstimateUsdPerDay?: number; // Cloudflare's free plan has no invoice; savings are an explicit, configurable estimate (default 0)
}

/**
 * Cloudflare adapter (Workers KV namespaces).
 *  - Read token: API token with "Workers KV Storage: Read" on the account. Used for inventory and sync.
 *  - Remediation token: a SEPARATE API token with "Workers KV Storage: Edit" (credentialRef cred/remediation-scoped).
 * Cloudflare tokens cannot be conditioned on a tag, so the provider-side "only if approved" guard of LocalCloud does not
 * exist here; instead the adapter re-checks emptiness right before deleting and the platform's approval gate is the control.
 * STATUS: written against the documented REST envelope and tested against a mock; validate live with scripts/cloudflare-smoke.mjs.
 */
export class CloudflareProvider implements CloudProvider {
  private base: string;
  constructor(private o: CloudflareOptions) { this.base = (o.baseUrl ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, ''); }

  private async cf(method: string, path: string, token: string): Promise<{ result: any; info?: any }> {
    let r: Response;
    try { r = await fetch(this.base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }); }
    catch (e) { throw new Error(`cloudflare network error: ${(e as Error).message}`); } // transient -> engine retries
    const json: any = await r.json().catch(() => ({}));
    if (r.status === 429 || r.status >= 500) throw new Error(`cloudflare ${r.status}`); // transient
    if (!r.ok || json.success === false) {
      const msg = (json.errors ?? []).map((e: any) => e.message).join('; ');
      const err = new PermanentError(`cloudflare refused: ${r.status} ${msg}`.trim());
      (err as any).status = r.status;
      throw err;
    }
    return { result: json.result, info: json.result_info };
  }

  private nsPath(id = '') { return `/accounts/${encodeURIComponent(this.o.accountId)}/storage/kv/namespaces${id ? `/${encodeURIComponent(id)}` : ''}`; }

  async listNamespaces(): Promise<{ id: string; title: string }[]> {
    const out: any[] = [];
    for (let page = 1; ; page += 1) {
      const { result, info } = await this.cf('GET', `${this.nsPath()}?page=${page}&per_page=100`, this.o.readToken);
      out.push(...result);
      if (!info?.total_pages || page >= info.total_pages) return out;
    }
  }

  private async isEmpty(id: string, token: string) {
    const { result } = await this.cf('GET', `${this.nsPath(id)}/keys?limit=1`, token);
    return result.length === 0;
  }

  /** Inventory-based recommendations: namespaces without any key. */
  async recommendations(orgId: string): Promise<Recommendation[]> {
    const today = new Date().toISOString().slice(0, 10);
    const est = (this.o.kvEstimateUsdPerDay ?? 0) * 30;
    const recs: Recommendation[] = [];
    for (const n of await this.listNamespaces()) {
      if (!(await this.isEmpty(n.id, this.o.readToken))) continue;
      const resource_id = `kv:${n.id}`;
      recs.push({
        id: 'rec-' + createHash('sha256').update(`${orgId}|${resource_id}`).digest('hex').slice(0, 12),
        kind: 'delete_orphan', resource_id, service: `Workers KV (${n.title})`, region: 'global',
        monthly_savings_usd: Math.round(est * 100) / 100, days_observed: 0,
        evidence: { record_count: 0, first_date: today, last_date: today, sample_record_ids: [] },
        rationale: `KV namespace "${n.title}" contains no keys. On the free plan the saving is $0 (inventory hygiene); set CLOUDFLARE_KV_EST_USD_PER_DAY for a paid-plan estimate.`,
      });
    }
    return recs;
  }

  /** One row per namespace per day at the configured estimate (Cloudflare exposes no per-resource invoice on the free plan). */
  async billingCsv(from?: string, to?: string): Promise<string> {
    const start = from ?? new Date().toISOString().slice(0, 10); const end = to ?? start;
    const days: string[] = [];
    for (let d = new Date(start + 'T00:00:00Z'); d <= new Date(end + 'T00:00:00Z') && days.length < 366; d = new Date(d.getTime() + 86400000)) days.push(d.toISOString().slice(0, 10));
    const esc = (v: string) => v.replace(/[",\n]/g, ' ');
    const rows = (await this.listNamespaces()).flatMap((n) => days.map((day) =>
      [day, this.o.accountId, 'unassigned', 'Workers KV', 'global', 'unknown', `kv:${n.id}`, String(this.o.kvEstimateUsdPerDay ?? 0), 'USD', 'source=estimate'].map(esc).join(',')));
    return ['date,account_id,project,service,region,environment,resource_id,cost,currency,tags', ...rows].join('\n') + '\n';
  }

  async deleteResource(resourceId: string, credential: string | undefined, idempotencyKey: string) {
    if (!credential) throw new PermanentError('remediation credential is not configured');
    if (credential === this.o.readToken) throw new PermanentError('remediation credential must differ from the read-only token');
    const m = /^kv:([A-Za-z0-9]+)$/.exec(resourceId);
    if (!m) throw new PermanentError(`unsupported resource ${resourceId}`);
    try {
      // Guard right before the destructive call: the namespace may have received data since the plan was approved.
      if (!(await this.isEmpty(m[1], credential))) throw new PermanentError('namespace is no longer empty; refusing to delete');
      await this.cf('DELETE', this.nsPath(m[1]), credential);
    } catch (e: any) {
      // Already gone (e.g. a previous attempt succeeded but its result was not persisted): the desired state holds.
      if (e?.status === 404) return { applied: true, mode: 'provider', deleted: resourceId, alreadyAbsent: true, idempotencyKey };
      throw e;
    }
    return { applied: true, mode: 'provider', deleted: resourceId, idempotencyKey };
  }
}
