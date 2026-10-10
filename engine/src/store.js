/** In-memory store, strictly scoped by organisation. snapshot()/restore() simulate durability. */
export class MemoryStore {
  constructor(data = {}) { this.data = data; }
  _k(kind) { return (this.data[kind] ??= {}); }
  put(kind, orgId, id, obj) { this._k(kind)[`${orgId}/${id}`] = structuredClone(obj); return obj; }
  get(kind, orgId, id) {
    const v = this._k(kind)[`${orgId}/${id}`];
    return v === undefined ? undefined : structuredClone(v);
  }
  has(kind, orgId, id) { return `${orgId}/${id}` in this._k(kind); }
  list(kind, orgId) {
    const prefix = `${orgId}/`;
    return Object.entries(this._k(kind)).filter(([k]) => k.startsWith(prefix)).map(([, v]) => structuredClone(v));
  }
  snapshot() { return JSON.stringify(this.data); }
  static restore(json) { return new MemoryStore(JSON.parse(json)); }
}
