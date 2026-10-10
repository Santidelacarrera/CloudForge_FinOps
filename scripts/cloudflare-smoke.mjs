// READ-ONLY smoke test against the real Cloudflare API. Makes only GET requests; never deletes anything.
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_READ_TOKEN=... node scripts/cloudflare-smoke.mjs
// Token needs: Account > Workers KV Storage > Read. If this prints a failure, the adapter's assumptions
// about the API (api/src/cloudflare.ts) need adjusting before real use.
const { CLOUDFLARE_ACCOUNT_ID: acc, CLOUDFLARE_READ_TOKEN: token } = process.env;
const base = (process.env.CLOUDFLARE_API_URL ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
if (!acc || !token) { console.error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_READ_TOKEN'); process.exit(2); }

const get = async (p) => {
  const r = await fetch(base + p, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`GET ${p.split('?')[0]} -> ${r.status} ${(j.errors ?? []).map((e) => e.message).join('; ')}`);
  return j;
};

try {
  const checks = [];
  const names = [];
  for (let page = 1; ; page += 1) {
    const j = await get(`/accounts/${encodeURIComponent(acc)}/storage/kv/namespaces?page=${page}&per_page=100`);
    if (!Array.isArray(j.result)) throw new Error('unexpected shape: result is not an array');
    names.push(...j.result);
    if (!j.result_info?.total_pages || page >= j.result_info.total_pages) break;
  }
  checks.push(`listed ${names.length} KV namespace(s)`);
  let empty = 0;
  for (const n of names.slice(0, 20)) {
    const j = await get(`/accounts/${encodeURIComponent(acc)}/storage/kv/namespaces/${encodeURIComponent(n.id)}/keys?limit=1`);
    if (!Array.isArray(j.result)) throw new Error('unexpected shape for keys');
    if (j.result.length === 0) { empty += 1; console.log(`  empty: ${n.title} (${n.id})`); }
  }
  checks.push(`${empty} empty among the first ${Math.min(20, names.length)}`);
  console.log('OK (read-only):', checks.join('; '));
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
