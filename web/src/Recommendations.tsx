import { useState } from 'react';
import { api, usd } from './api';
import { useApi } from './hooks';

export function Recommendations() {
  const recs = useApi<any[]>('/recommendations');
  const [plans, setPlans] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState('');
  const wf = useApi<any[]>('/workflows');
  const simulate = async (id: string) => {
    try { const p = await api('POST', `/recommendations/${id}/simulate`); setPlans((x) => ({ ...x, [id]: p })); setMsg(''); } catch (e) { setMsg((e as Error).message); }
  };
  const start = async (id: string) => {
    try {
      const r = await api('POST', '/workflows/orphan-cleanup-with-approval/run', { input: { recommendationId: id } });
      setMsg(`Ejecución ${r.executionId} iniciada: se detendrá en la bandeja de aprobaciones.`);
    } catch (e) { setMsg((e as Error).message); }
  };
  const hasWf = wf.data?.some((w) => w.ref.startsWith('orphan-cleanup-with-approval'));
  return (
    <section className="card">
      <h2>Recomendaciones</h2>
      {recs.error && <p className="err">{recs.error}</p>}
      {msg && <p role="status">{msg}</p>}
      {recs.data?.length === 0 && <p className="muted">Sin recomendaciones.</p>}
      {recs.data?.map((r) => (
        <article key={r.id} className="card" style={{ marginBottom: 12 }}>
          <div className="row"><strong>{r.resource_id}</strong><span className="badge info">{r.kind}</span><span className="muted">{r.service} · {r.region}</span>
            <span style={{ marginLeft: 'auto' }}>Ahorro bruto estimado: <strong>{usd(r.monthly_savings_usd)}/mes</strong></span></div>
          <p className="muted">{r.rationale}</p>
          <details><summary>Evidencia ({r.evidence.record_count} registros, {r.evidence.first_date} → {r.evidence.last_date})</summary>
            <p className="muted">Registros de muestra: {r.evidence.sample_record_ids.join(', ')}</p></details>
          <div className="row">
            <button className="btn ghost" onClick={() => simulate(r.id)}>Simular (dry-run)</button>
            <button className="btn" disabled={!hasWf} title={hasWf ? '' : 'Publica el flujo orphan-cleanup-with-approval primero'} onClick={() => start(r.id)}>Iniciar flujo con aprobación</button>
          </div>
          {plans[r.id] && (<>
            <p><span className="badge ok">dry-run · sin efectos</span> <span className="muted">hash {plans[r.id].planHash.slice(0, 12)}</span></p>
            <pre>{plans[r.id].plan.terraformDiff}</pre>
            <strong>Riesgos</strong><ul>{plans[r.id].plan.risks.map((x: string) => <li key={x}>{x}</li>)}</ul>
            <strong>Supuestos</strong><ul>{plans[r.id].plan.assumptions.map((x: string) => <li key={x}>{x}</li>)}</ul>
          </>)}
        </article>
      ))}
    </section>
  );
}
