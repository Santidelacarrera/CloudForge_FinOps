// LocalCloud: a tiny, free, self-contained "cloud provider" used to exercise CloudForge end to end.
// It models the controls a real provider offers: a read-only token, a narrowly scoped write token,
// provider-side enforcement (delete only if tagged approved AND unattached) and idempotent deletes.
//   LOCALCLOUD_READ_TOKEN=... LOCALCLOUD_WRITE_TOKEN=... node providers/localcloud/server.mjs
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const APPROVAL_TAG = 'cloudforge:approved-for-deletion';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadLedger(file = path.join(root, 'datasets/sample_billing.csv')) {
  const [head, ...lines] = readFileSync(file, 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => {
    const v = l.split(',');
    const r = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    return { ...r, tags: Object.fromEntries((r.tags || '').split(';').filter((x) => x.includes('=')).map((x) => x.split('='))) };
  }).filter((r) => r.resource_id && !Number.isNaN(Number(r.cost)) && ['USD', 'EUR'].includes(r.currency));
}

export function createCloud({ readToken, writeToken, ledger = loadLedger() }) {
  if (!readToken || !writeToken || readToken === writeToken) throw new Error('distinct read and write tokens are required');
  const resources = new Map();
  for (const r of ledger) {
    if (!resources.has(r.resource_id)) {
      resources.set(r.resource_id, { id: r.resource_id, service: r.service, region: r.region, tags: { ...r.tags }, attached: r.resource_id !== 'vol-0orphan01', state: 'available' });
    }
  }
  const idem = new Map(); // idempotency-key -> stored response
  const log = [];

  const server = createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const role = bearer === writeToken ? 'write' : bearer === readToken ? 'read' : null;
    if (!role) return send(401, { error: 'unauthorized' });
    const url = new URL(req.url, 'http://x');
    const m = /^\/v1\/resources\/([^/]+)(\/tags)?$/.exec(url.pathname);
    log.push(`${role} ${req.method} ${url.pathname}`);

    if (req.method === 'GET' && url.pathname === '/v1/billing/daily') {
      const from = url.searchParams.get('from') ?? '0000-00-00'; const to = url.searchParams.get('to') ?? '9999-99-99';
      return send(200, { items: ledger.filter((r) => r.date >= from && r.date <= to) });
    }
    if (req.method === 'GET' && url.pathname === '/v1/resources') return send(200, { items: [...resources.values()] });
    if (req.method === 'GET' && m && !m[2]) return resources.has(m[1]) ? send(200, resources.get(m[1])) : send(404, { error: 'not found' });

    // ---- everything below mutates: requires the scoped write token ----
    if (role !== 'write') return send(403, { error: 'read-only token' });
    const key = req.headers['idempotency-key'];
    if (key && idem.has(key)) { const [c, b] = idem.get(key); return send(c, { ...b, replayed: true }); }
    const reply = (c, b) => { if (key && c < 500) idem.set(key, [c, b]); return send(c, b); };
    const r = m && resources.get(m[1]);
    if (!r) return reply(404, { error: 'not found' });

    if (req.method === 'POST' && m[2]) { // tag: only the approval tag may be written
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (Object.keys(body).some((k) => k !== APPROVAL_TAG)) return reply(403, { error: `write token may only set ${APPROVAL_TAG}` });
      Object.assign(r.tags, body);
      return reply(200, { id: r.id, tags: r.tags });
    }
    if (req.method === 'DELETE' && !m[2]) {
      if (r.tags[APPROVAL_TAG] !== 'true') return reply(403, { error: `resource is not tagged ${APPROVAL_TAG}=true` });
      if (r.attached) return reply(409, { error: 'resource is attached; refusing to delete' });
      resources.delete(r.id);
      return reply(200, { deleted: r.id });
    }
    return send(405, { error: 'method not allowed' });
  });
  return { server, resources, log, idem };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createCloud({ readToken: process.env.LOCALCLOUD_READ_TOKEN, writeToken: process.env.LOCALCLOUD_WRITE_TOKEN });
  server.listen(Number(process.env.PORT ?? 4010), () => console.log('localcloud listening'));
}
