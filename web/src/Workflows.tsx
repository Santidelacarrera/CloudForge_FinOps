import { useMemo, useState } from 'react';
import { api } from './api';
import { useApi } from './hooks';

const SAMPLE = {
  id: 'orphan-cleanup-with-approval', name: 'Delete orphaned resource',
  nodes: [
    { id: 'plan', type: 'simulate', params: { simulator: 'recommendation' } },
    { id: 'approve', type: 'approval', params: { planFrom: 'plan', requiredRole: 'approver' } },
    { id: 'apply', type: 'apply_plan', params: { planFrom: 'plan' } },
    { id: 'done', type: 'notify', params: { message: 'Deleted {{outputs.plan.resource}}' } },
  ],
  edges: [{ from: 'plan', to: 'approve' }, { from: 'approve', to: 'apply' }, { from: 'apply', to: 'done' }],
};

function order(def: any): any[] {
  const next = new Map<string, string>(def.edges.map((e: any) => [e.from, e.to]));
  const targets = new Set(def.edges.map((e: any) => e.to));
  const out: any[] = [];
  for (let n = def.nodes.find((x: any) => !targets.has(x.id))?.id; n && out.length <= def.nodes.length; n = next.get(n)) out.push(def.nodes.find((x: any) => x.id === n));
  return out.filter(Boolean);
}

export function Workflows() {
  const list = useApi<any[]>('/workflows');
  const [text, setText] = useState(JSON.stringify(SAMPLE, null, 2));
  const [msg, setMsg] = useState('');
  const parsed = useMemo(() => { try { return { def: JSON.parse(text) as any, err: '' }; } catch (e) { return { def: null, err: (e as Error).message }; } }, [text]);
  const chain = parsed.def?.nodes && parsed.def?.edges ? order(parsed.def) : [];
  const publish = async () => {
    try { const r = await api('POST', '/workflows', parsed.def); setMsg(`Publicado ${r.ref} (hash ${r.contentHash.slice(0, 10)}, inmutable)`); void list.reload(); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div className="grid2">
      <section className="card">
        <h2>Editor de flujo</h2>
        <textarea aria-label="Definición del flujo (JSON)" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        {parsed.err && <p className="err">JSON inválido: {parsed.err}</p>}
        <div className="row"><button className="btn" disabled={!parsed.def} onClick={publish}>Publicar nueva versión</button></div>
        {msg && <p role="status" className={/Publicado/.test(msg) ? '' : 'err'}>{msg}</p>}
        <p className="muted">Un nodo destructivo solo se acepta si lo preceden un nodo <code>simulate</code> y uno <code>approval</code> del mismo plan.</p>
      </section>
      <section className="card">
        <h2>Vista del flujo</h2>
        <div className="flow" aria-label="Pasos del flujo">
          {chain.map((n, i) => (
            <span key={n.id} className="row">
              {i > 0 && <span className="arrow" aria-hidden>→</span>}
              <span className={`node ${n.type === 'apply_plan' ? 'destructive' : n.type === 'approval' ? 'approval' : ''}`}>
                <strong>{n.id}</strong><div className="muted">{n.type}</div>
                {n.type === 'approval' && <div className="badge warn">humano</div>}
                {n.type === 'apply_plan' && <div className="badge bad">destructivo</div>}
              </span>
            </span>
          ))}
        </div>
        <h2 style={{ marginTop: 20 }}>Versiones publicadas</h2>
        {list.error && <p className="err">{list.error}</p>}
        <table><thead><tr><th>Ref</th><th>Nodos</th><th>Hash</th></tr></thead>
          <tbody>{list.data?.map((w) => <tr key={w.ref}><td>{w.ref}</td><td>{w.nodes}</td><td className="muted">{w.contentHash.slice(0, 12)}</td></tr>)}</tbody></table>
      </section>
    </div>
  );
}
