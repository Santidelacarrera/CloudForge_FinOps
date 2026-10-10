// Test double for the subset of the Cloudflare REST API used by CloudForge (Workers KV namespaces).
// It reproduces the documented response envelope {success, errors, messages, result, result_info}
// and scoped API tokens. It is NOT Cloudflare: real behaviour must be checked with scripts/cloudflare-smoke.mjs.
import { createServer } from 'node:http';

export function createCloudflareMock({ accountId, readToken, writeToken, namespaces, pageLimit = 100 }) {
  const ns = new Map(namespaces.map((n) => [n.id, { ...n, keys: [...(n.keys ?? [])] }]));
  const log = [];
  let rateLimitNext = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, result, extra = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...(extra.headers ?? {}) });
      res.end(JSON.stringify({ success: code < 300, errors: code < 300 ? [] : [{ code, message: extra.message ?? 'error' }], messages: [], result, ...(extra.info ? { result_info: extra.info } : {}) }));
    };
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const role = token === writeToken ? 'write' : token === readToken ? 'read' : null;
    log.push(`${role ?? 'anon'} ${req.method} ${url.pathname}`);
    if (!role) return send(401, null, { message: 'Invalid API Token' });
    if (rateLimitNext > 0) { rateLimitNext -= 1; return send(429, null, { message: 'rate limited', headers: { 'retry-after': '0' } }); }
    const base = `/client/v4/accounts/${accountId}/storage/kv/namespaces`;
    if (!url.pathname.startsWith(base)) return send(404, null, { message: 'not found' });
    const rest = url.pathname.slice(base.length);

    if (req.method === 'GET' && rest === '') {
      const page = Number(url.searchParams.get('page') ?? 1); const per = Math.min(Number(url.searchParams.get('per_page') ?? pageLimit), pageLimit);
      const all = [...ns.values()].map(({ keys, ...n }) => n);
      return send(200, all.slice((page - 1) * per, page * per), { info: { page, per_page: per, count: Math.min(per, all.length - (page - 1) * per), total_count: all.length, total_pages: Math.max(1, Math.ceil(all.length / per)) } });
    }
    const m = /^\/([^/]+)(\/keys)?$/.exec(rest);
    if (!m || !ns.has(m[1])) return send(404, null, { message: 'namespace not found' });
    const n = ns.get(m[1]);
    if (req.method === 'GET' && m[2]) {
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      return send(200, n.keys.slice(0, limit).map((name) => ({ name })), { info: { count: Math.min(limit, n.keys.length) } });
    }
    if (req.method === 'DELETE' && !m[2]) {
      if (role !== 'write') return send(403, null, { message: 'insufficient permissions' });
      ns.delete(n.id);
      return send(200, null);
    }
    return send(405, null, { message: 'method not allowed' });
  });
  return { server, ns, log, rateLimit: (n) => { rateLimitNext = n; } };
}
