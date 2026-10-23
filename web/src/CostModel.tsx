import { useState } from 'react';
import { api, usd } from './api';
import { useApi } from './hooks';

const STATUS: Record<string, { cls: string; label: string }> = {
  ok: { cls: 'ok', label: 'dentro de presupuesto' }, watch: { cls: 'info', label: 'vigilar' },
  at_risk: { cls: 'warn', label: 'en riesgo' }, exceeded: { cls: 'bad', label: 'superado' },
  no_data: { cls: 'info', label: 'sin datos' }, insufficient_data: { cls: 'info', label: 'datos insuficientes' },
};

export function CostModel() {
  const [asOf, setAsOf] = useState('');
  const [by, setBy] = useState('owner');
  const q = asOf ? `&as_of=${asOf}` : '';
  const budgets = useApi<any[]>(`/budgets/status?${q.slice(1)}`);
  const alloc = useApi(`/costs/allocation?by=${by}`);
  const variance = useApi(`/costs/variance${asOf ? `?as_of=${asOf}` : ''}`);
  const [ack, setAck] = useState('');
  const anomalies = useApi<any[]>('/anomalies');
  const acknowledge = async (id: string) => {
    try { await api('POST', `/anomalies/${id}/ack`); setAck(`Anomalía ${id} reconocida`); void anomalies.reload(); } catch (e) { setAck((e as Error).message); }
  };

  return (
    <>
      <section className="card" aria-labelledby="h-bud">
        <h2 id="h-bud">Presupuestos</h2>
        <label className="muted">Calcular a fecha{' '}
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} aria-label="Fecha de corte" /></label>
        {budgets.error && <p className="err">{budgets.error}</p>}
        {budgets.data?.length === 0 && <p className="muted">Sin presupuestos definidos.</p>}
        <table>
          <thead><tr><th>Alcance</th><th>Mes</th><th className="num">Presupuesto</th><th className="num">Gastado</th><th className="num">Proyección</th><th>Estado</th></tr></thead>
          <tbody>{budgets.data?.map((b) => {
            const st = STATUS[b.status] ?? STATUS.no_data;
            return (
              <tr key={b.id}>
                <td>{b.scope_type === 'total' ? 'Total' : `${b.scope_type}: ${b.scope_value}`}</td><td>{b.month}</td>
                <td className="num">{usd(b.amount)}</td>
                <td className="num">{b.month_to_date !== undefined ? `${usd(b.month_to_date)} (${b.pct_spent}%)` : '—'}</td>
                <td className="num">{b.projected !== undefined ? `${usd(b.projected)} (${b.projected_pct}%)` : '—'}</td>
                <td><span className={`badge ${st.cls}`}>{st.label}</span>
                  {b.events?.length > 0 && <div className="muted">umbrales: {b.events.map((e: any) => `${Math.round(e.threshold * 100)}%`).join(', ')}</div>}
                  {b.assumptions && <details><summary>método</summary><div className="muted">{b.method.name} · ventana {b.method.window_days} d<ul>{b.assumptions.map((a: string) => <li key={a}>{a}</li>)}</ul></div></details>}
                </td>
              </tr>);
          })}</tbody>
        </table>
      </section>

      <div className="grid2">
        <section className="card" aria-labelledby="h-alloc">
          <h2 id="h-alloc">Asignación de costos por <select value={by} onChange={(e) => setBy(e.target.value)} aria-label="Asignar por"><option>owner</option><option>project</option></select></h2>
          {alloc.error && <p className="err">{alloc.error}</p>}
          {alloc.data && (<>
            <p>Cobertura de etiquetas: <strong>{alloc.data.coverage_pct ?? '—'}%</strong>{' '}
              <span className="muted">· sin asignar {usd(alloc.data.unallocated_total)} de {usd(alloc.data.total)}</span></p>
            <table><thead><tr><th>Grupo</th><th className="num">Total</th><th className="num">Registros</th></tr></thead>
              <tbody>{alloc.data.groups.map((g: any) => (
                <tr key={g.group}><td>{g.group === 'unallocated' ? <span className="badge warn">sin asignar</span> : g.group}</td>
                  <td className="num">{usd(g.total)}</td><td className="num">{g.record_count}</td></tr>))}</tbody></table>
          </>)}
        </section>

        <section className="card" aria-labelledby="h-var">
          <h2 id="h-var">Variación mes contra mes</h2>
          {variance.error && <p className="err">{variance.error}</p>}
          {variance.data && (<>
            <p className="muted">Días 1–{variance.data.period_days} de {variance.data.current_month} frente a los mismos días de {variance.data.prior_month}</p>
            <table><thead><tr><th>Servicio</th><th className="num">Actual</th><th className="num">Anterior</th><th className="num">Cambio</th></tr></thead>
              <tbody>{variance.data.rows.map((r: any) => (
                <tr key={r.series} title={r.explanation}><td>{r.series}</td><td className="num">{usd(r.current)}</td><td className="num">{usd(r.prior)}</td>
                  <td className="num">{r.delta >= 0 ? '+' : ''}{usd(r.delta)}{r.pct !== null ? ` (${r.pct}%)` : ''}</td></tr>))}</tbody></table>
          </>)}
        </section>
      </div>

      <section className="card" aria-labelledby="h-an2">
        <h2 id="h-an2">Anomalías (entidades persistidas)</h2>
        {ack && <p role="status">{ack}</p>}
        <table><thead><tr><th>Fecha</th><th>Serie</th><th className="num">Cambio</th><th>Estado</th><th></th></tr></thead>
          <tbody>{anomalies.data?.map((a) => (
            <tr key={a.id}><td>{a.date}</td><td>{a.series}</td><td className="num">+{usd(a.delta)}</td>
              <td><span className={`badge ${a.status === 'open' ? 'warn' : 'ok'}`}>{a.status === 'open' ? 'abierta' : 'reconocida'}</span></td>
              <td>{a.status === 'open' && <button className="btn ghost" onClick={() => acknowledge(a.id)}>Reconocer</button>}</td></tr>))}</tbody></table>
      </section>
    </>
  );
}
