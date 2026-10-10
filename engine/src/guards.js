import { isIP } from 'node:net';
import { SafetyError } from './util.js';

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export function isPrivateIp(ip) {
  if (isIP(ip) === 4) return PRIVATE_V4.some((r) => r.test(ip));
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/**
 * SSRF guard for webhook nodes: https only, host on the org allowlist, and every
 * resolved address must be public. `resolve` is injectable (DNS) for testing.
 */
export async function assertSafeWebhook(rawUrl, allowlist, resolve) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new SafetyError('invalid webhook URL'); }
  if (u.protocol !== 'https:') throw new SafetyError('webhook must use https');
  if (u.username || u.password) throw new SafetyError('credentials in URL are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowlist.map((h) => h.toLowerCase()).includes(host)) throw new SafetyError(`host ${host} not in allowlist`);
  const addrs = isIP(host) ? [host] : await resolve(host);
  if (!addrs.length) throw new SafetyError('host does not resolve');
  if (addrs.some(isPrivateIp)) throw new SafetyError('webhook resolves to a private address');
  return u;
}

/** Minimal strict JSON-schema subset used to validate AI node output. */
export function validateSchema(value, schema) {
  const errs = [];
  const walk = (v, s, path) => {
    if (s.enum && !s.enum.includes(v)) errs.push(`${path}: not in enum`);
    if (s.type === 'string') {
      if (typeof v !== 'string') errs.push(`${path}: expected string`);
      else if (s.maxLength && v.length > s.maxLength) errs.push(`${path}: too long`);
    } else if (s.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`${path}: expected number`);
      else if ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum)) errs.push(`${path}: out of range`);
    } else if (s.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errs.push(`${path}: expected object`); return; }
      for (const r of s.required ?? []) if (!(r in v)) errs.push(`${path}.${r}: required`);
      for (const k of Object.keys(v)) {
        if (!s.properties?.[k]) errs.push(`${path}.${k}: unexpected property`);
        else walk(v[k], s.properties[k], `${path}.${k}`);
      }
    }
  };
  walk(value, schema, '$');
  return errs;
}
