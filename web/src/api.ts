export const getToken = () => { try { return sessionStorage.getItem('cf_token') ?? ''; } catch { return ''; } };
export const setToken = (t: string) => { try { sessionStorage.setItem('cf_token', t); } catch { /* storage unavailable */ } };

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(Array.isArray(json.message) ? json.message.join(', ') : json.message ?? `HTTP ${r.status}`);
  return json as T;
}
export const usd = (n: number | string) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
