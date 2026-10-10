import { createHash } from 'node:crypto';

export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export const hash = (v) => createHash('sha256').update(stable(v)).digest('hex');

export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

/** Transient errors are retried; permanent ones fail the step immediately. */
export class PermanentError extends Error {}
/** Raised when a safety invariant would be violated. Never retried. */
export class SafetyError extends PermanentError {}

const SECRET_KEY = /(secret|token|password|passwd|api[-_]?key|authorization|credential)/i;
/** Mask secret-looking keys and any known secret values, recursively. */
export function redact(value, knownSecrets = []) {
  const mask = (s) => knownSecrets.reduce((acc, k) => (k ? acc.split(k).join('***') : acc), s);
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, knownSecrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, SECRET_KEY.test(k) && typeof v !== 'object' ? '***' : redact(v, knownSecrets)]));
  }
  return value;
}
