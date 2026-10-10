import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import IORedis from 'ioredis';
// The engine is plain ESM JavaScript; Node >= 22.12 can require() it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Engine } = require('@cloudforge/engine');
const { PgStore } = require('@cloudforge/engine/pg-store');
const { ExecutionQueue } = require('@cloudforge/engine/queue');
import { buildDeletePlan } from './plans';
import { listRecommendations } from './finance';
import { CloudProvider, HttpProvider } from './provider';
import { CloudflareProvider } from './cloudflare';

/** Wires store, engine, queue and the (demo) connectors. */
@Injectable()
export class CoreService implements OnModuleInit, OnModuleDestroy {
  store: any; engine: any; queue: any; redis?: IORedis;
  provider?: CloudProvider;
  analyticsUrl = process.env.ANALYTICS_URL ?? 'http://127.0.0.1:8000';

  async onModuleInit() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required');
    this.store = new PgStore(url);
    if (process.env.PROVIDER_KIND === 'cloudflare') {
      const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_READ_TOKEN: readToken } = process.env;
      if (!accountId || !readToken) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_READ_TOKEN are required for PROVIDER_KIND=cloudflare');
      this.provider = new CloudflareProvider({ accountId, readToken, baseUrl: process.env.CLOUDFLARE_API_URL, kvEstimateUsdPerDay: Number(process.env.CLOUDFLARE_KV_EST_USD_PER_DAY ?? 0) });
    } else if (process.env.PROVIDER_URL) {
      if (!process.env.PROVIDER_READ_TOKEN) throw new Error('PROVIDER_READ_TOKEN is required with PROVIDER_URL');
      this.provider = new HttpProvider(process.env.PROVIDER_URL, process.env.PROVIDER_READ_TOKEN);
    }
    this.engine = new Engine({
      store: this.store,
      credentials: (ref: string) => process.env[`CRED_${ref.replace(/\W/g, '_').toUpperCase()}`],
      connectors: {
        webhookAllowlist: (process.env.WEBHOOK_ALLOWLIST ?? '').split(',').filter(Boolean),
        simulators: {
          // Dry-run only: reads recommendation evidence from our own DB and returns a plan document.
          recommendation: async (input: any, _p: any, ctx: { orgId: string }) => {
            const rec = (await this.recommendations(ctx.orgId)).find((r) => r.id === input.recommendationId);
            if (!rec) throw new Error(`unknown recommendation ${input.recommendationId}`);
            return buildDeletePlan(rec);
          },
        },
        // With PROVIDER_URL: real calls to the provider using the scoped remediation credential
        // (CRED_CRED_REMEDIATION_SCOPED). Without it: DEMO mode records the action and calls nothing.
        cloud: {
          apply: async (plan: any, { idempotencyKey, credential }: { idempotencyKey: string; credential?: string }) => {
            if (this.provider) return this.provider.deleteResource(plan.resource, credential, idempotencyKey);
            return { applied: true, mode: 'demo-no-cloud-call', resource: plan.resource, idempotencyKey };
          },
        },
        notify: async (m: any) => ({ delivered: true, text: m.text }),
      },
    });
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      this.redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
      this.queue = new ExecutionQueue(this.redis, process.env.QUEUE_NAME ?? 'cloudforge-executions');
      if (process.env.WORKER_ENABLED !== 'false') this.queue.startWorker(this.engine);
    }
  }

  /** Billing-derived recommendations plus any inventory-based ones the provider contributes. */
  async recommendations(orgId: string) {
    const fromBilling = await listRecommendations(this.store, orgId);
    const fromInventory = (await this.provider?.recommendations?.(orgId)) ?? [];
    return [...fromBilling, ...fromInventory];
  }

  async startExecution(orgId: string, workflowRef: string, input: any, opts: { eventId: string; actor: string }) {
    if (this.queue) await this.queue.enqueueStart(orgId, workflowRef, input, opts);
    else await this.engine.start(orgId, workflowRef, input, opts); // no Redis configured: run inline
  }
  async resumeExecution(orgId: string, execId: string) {
    if (this.queue) await this.queue.enqueueResume(orgId, execId);
    else await this.engine.resume(orgId, execId);
  }

  async onModuleDestroy() {
    await this.queue?.close(); await this.redis?.quit().catch(() => {}); await this.store?.close();
  }
}
