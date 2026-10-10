import type { Recommendation } from './plans';
const { PermanentError } = require('@cloudforge/engine');

export const APPROVAL_TAG = 'cloudforge:approved-for-deletion';

/** What the platform needs from a cloud: read billing/inventory with a read-only credential, delete with a scoped one. */
export interface CloudProvider {
  /** READ-ONLY. Standard CSV (see datasets/sample_billing.csv). */
  billingCsv(from?: string, to?: string): Promise<string>;
  /** WRITE. Only reachable from an approved apply_plan step. Must honour idempotencyKey (or be naturally idempotent). */
  deleteResource(resourceId: string, credential: string | undefined, idempotencyKey: string): Promise<any>;
  /** Optional READ-ONLY inventory-based recommendations (for providers without per-resource billing). */
  recommendations?(orgId: string): Promise<Recommendation[]>;
}

/** Generic HTTP provider (LocalCloud contract). */
export class HttpProvider implements CloudProvider {
  constructor(private baseUrl: string, private readToken: string) {}

  private async req(method: string, path: string, token: string, body?: unknown, idemKey?: string) {
    const r = await fetch(this.baseUrl + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(idemKey ? { 'idempotency-key': idemKey } : {}) },
    });
    const json: any = await r.json().catch(() => ({}));
    // 5xx / network errors are thrown as plain Errors (the engine retries them); 4xx are permanent.
    if (r.status >= 500) throw new Error(`provider ${r.status}`);
    if (!r.ok) throw new PermanentError(`provider refused: ${r.status} ${json.error ?? ''}`.trim());
    return json;
  }

  async billingCsv(from?: string, to?: string): Promise<string> {
    const q = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
    const { items } = await this.req('GET', `/v1/billing/daily?${q}`, this.readToken);
    const esc = (v: unknown) => String(v ?? '').replace(/[",\n]/g, ' ');
    const rows = items.map((i: any) => [i.date, i.account_id, i.project, i.service, i.region, i.environment, i.resource_id, i.cost, i.currency,
      Object.entries(i.tags ?? {}).map(([k, v]) => `${k}=${v}`).join(';')].map(esc).join(','));
    return ['date,account_id,project,service,region,environment,resource_id,cost,currency,tags', ...rows].join('\n') + '\n';
  }

  async deleteResource(resourceId: string, credential: string | undefined, idempotencyKey: string) {
    if (!credential) throw new PermanentError('remediation credential is not configured');
    const id = encodeURIComponent(resourceId);
    await this.req('POST', `/v1/resources/${id}/tags`, credential, { [APPROVAL_TAG]: 'true' }, `${idempotencyKey}:tag`);
    const out = await this.req('DELETE', `/v1/resources/${id}`, credential, undefined, `${idempotencyKey}:delete`);
    return { applied: true, mode: 'provider', deleted: out.deleted, idempotencyKey };
  }
}
