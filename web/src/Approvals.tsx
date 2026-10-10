import { useState } from 'react';
import { api } from './api';
import { useApi } from './hooks';

const statusClass = (s: string) => ({ SUCCEEDED: 'ok', FAILED: 'bad', REJECTED: 'bad', WAITING_APPROVAL: 'warn', RUNNING: 'info' } as Record<string, string>)[s] ?? 'info';

export function Approvals() {
  const approvals = useApi<any[]>('/approvals');
  const execs = useApi<any[]>('/executions');
  const [open, setOpen] = useState('');
  const detail = useApi(open ? `/executions/${open}` : null);
  const [msg, setMsg] = useState('');
  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    try { await api('POST', `/approvals/${id}/decision`, { decision }); setMsg(`Decisión registrada: ${decision}`); }
    catch (e) { setMsg((e as Error).message); }
    setTimeout(() => { void approvals.reload(); void execs.reload(); void detail.reload(); }, 600);
  };
  return (
    <>
      <section className="card" aria-labelledby="h-inbox">
        <h2 id="h-inbox">Bandeja de aprobaciones</h2>
        {msg && <p role="status">{msg}</p>}
        {approvals.error && <p className="err">{approvals.error}</p>}
        {approvals.data?.length === 0 && <p className="muted">Nada pendiente.</p>}
        {approvals.data?.map((a) => (
          <article key={a.id} className="card" style={{ marginBottom: 12 }}>
            <div className="row"><strong>{a.plan.action}</strong> <span>{a.plan.resource}</span>
              <span className={`badge ${a.status === 'pending' ? 'warn' : a.status === 'approved' ? 'ok' : 'bad'}`}>{a.status}</span>
              <span className="muted" style={{ marginLeft: 'auto' }}>solicitado por {a.requestedBy} · requiere rol {a.requiredRole}</span></div>
            <pre>{a.plan.terraformDiff}</pre>
            <p>Ahorro bruto estimado: <strong>${a.plan.estimatedMonthlySavingsUsd}/mes</strong> <span className="muted">· hash del plan {a.planHash.slice(0, 12)}</span></p>
            <details><summary>Riesgos</summary><ul>{a.plan.risks.map((r: string) => <li key={r}>{r}</li>)}</ul></details>
            {a.status === 'pending'
              ? <div className="row"><button className="btn ok" onClick={() => decide(a.id, 'approved')}>Aprobar</button><button className="btn bad" onClick={() => decide(a.id, 'rejected')}>Rechazar</button></div>
              : <p className="muted">Decidido por {a.decidedBy}</p>}
          </article>
        ))}
      </section>
      <section className="card" aria-labelledby="h-ex">
        <h2 id="h-ex">Ejecuciones</h2>
        <table><thead><tr><th>Id</th><th>Flujo</th><th>Estado</th><th></th></tr></thead>
          <tbody>{execs.data?.map((e) => (
            <tr key={e.id}><td>{e.id}</td><td>{e.workflow}</td><td><span className={`badge ${statusClass(e.status)}`}>{e.status}</span></td>
              <td><button className="btn ghost" onClick={() => setOpen(e.id)}>Ver pasos</button></td></tr>))}</tbody></table>
        {detail.data && open && (
          <div className="flow" aria-label="Historial de pasos">
            {detail.data.steps.map((s: any, i: number) => (
              <span key={s.nodeId} className="row">{i > 0 && <span className="arrow">→</span>}
                <span className="node"><strong>{s.nodeId}</strong><div><span className={`badge ${statusClass(s.status === 'WAITING_APPROVAL' ? 'WAITING_APPROVAL' : s.status)}`}>{s.status}</span></div>
                  <div className="muted">intentos: {s.attempts}</div></span></span>))}
          </div>
        )}
      </section>
    </>
  );
}
