import pg from 'pg';

/** PostgreSQL-backed store. Every operation runs in a transaction with app.org_id set, so RLS enforces tenancy. */
export class PgStore {
  constructor(connectionString) { this.pool = new pg.Pool({ connectionString }); }
  async tx(orgId, fn) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  async put(kind, orgId, id, obj) {
    await this.tx(orgId, (c) => c.query(
      `INSERT INTO engine_documents (org_id, kind, id, doc) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, kind, id) DO UPDATE SET doc = EXCLUDED.doc`, [orgId, kind, id, JSON.stringify(obj)]));
    return obj;
  }
  async get(kind, orgId, id) {
    const r = await this.tx(orgId, (c) => c.query('SELECT doc FROM engine_documents WHERE org_id=$1 AND kind=$2 AND id=$3', [orgId, kind, id]));
    return r.rows[0]?.doc;
  }
  /** Atomic read-modify-write using a row lock: concurrent updaters are serialised. */
  async update(kind, orgId, id, fn) {
    return this.tx(orgId, async (c) => {
      const r = await c.query('SELECT doc FROM engine_documents WHERE org_id=$1 AND kind=$2 AND id=$3 FOR UPDATE', [orgId, kind, id]);
      const next = await fn(r.rows[0]?.doc);
      await c.query('UPDATE engine_documents SET doc=$4 WHERE org_id=$1 AND kind=$2 AND id=$3', [orgId, kind, id, JSON.stringify(next)]);
      return next;
    });
  }
  async has(kind, orgId, id) { return (await this.get(kind, orgId, id)) !== undefined; }
  async list(kind, orgId) {
    const r = await this.tx(orgId, (c) => c.query('SELECT doc FROM engine_documents WHERE org_id=$1 AND kind=$2 ORDER BY seq', [orgId, kind]));
    return r.rows.map((x) => x.doc);
  }
  async close() { await this.pool.end(); }
}
