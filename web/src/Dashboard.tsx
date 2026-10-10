import { useState } from 'react';
import { usd } from './api';
import { useApi } from './hooks';

const GROUPS = ['service', 'project', 'environment', 'region', 'currency', 'untagged'];

export function Dashboard() {
  const [group, setGroup] = useState('service');
  const summary = useApi(`/costs/summary?group_by=${group}`);
  const anomalies = useApi<any[]>('/anomalies');
  const [asOf, setAsOf] = useState('');
  const forecast = useApi(`/forecasts${asOf ? `?as_of=${asOf}` : ''}`);
  const groups: any[] = summary.data?.groups ?? [];
  const max = Math.max(1, ...groups.map((g) => Number(g.total)));
  const total = groups.reduce((a, g) => a + Number(g.total), 0);
  const f = forecast.data;
  return (
    <>
      <div className="grid2">
        <section className="card" aria-labelledby="h-sum">
          <h2 id="h-sum">Gasto por <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Agrupar por">{GROUPS.map((g) => <option key={g}>{g}</option>)}</select></h2>
          {summary.error && <p className="err">{summary.error}</p>}
          <p className="muted">Total {usd(total)} · {groups.reduce((a, g) => a + g.record_count, 0)} registros origen</p>
          <table>
            <thead><tr><th>Grupo</th><th></th><th className="num">Total (USD)</th><th className="num">Registros</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.group}>
                  <td>{g.group}</td>
                  <td style={{ width: '35%' }}><div className="barwrap"><div className="bar" style={{ width: `${(Number(g.total) / max) * 100}%` }} /></div></td>
                  <td className="num">{usd(g.total)}</td>
                  <td className="num">
                    <details><summary>{g.record_count}</summary>
                      <div className="muted" style={{ textAlign: 'left', maxWidth: 260, wordBreak: 'break-all' }}>
                        Líneas del CSV: {g.source_lines.slice(0, 40).join(', ')}{g.source_lines.length > 40 ? ' …' : ''}
                      </div>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card" aria-labelledby="h-fc">
          <h2 id="h-fc">Pronóstico de cierre de mes</h2>
          <label className="muted">Calcular a fecha{' '}<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} aria-label="Fecha de corte del pronóstico" /></label>
          {forecast.error && <p className="err">{forecast.error}</p>}
          {f && (<>
            <p style={{ fontSize: 26, margin: '0 0 4px' }}>{usd(f.point_estimate)}</p>
            <p className="muted">Intervalo 95 %: {usd(f.interval_95[0])} – {usd(f.interval_95[1])} · 80 %: {usd(f.interval_80[0])} – {usd(f.interval_80[1])}</p>
            {f.budget && <p><span className={`badge ${f.interval_95[1] > f.budget ? 'warn' : 'ok'}`}>{f.budget_exceed_probability_note}</span> {f.pct_of_budget_projected}% del presupuesto ({usd(f.budget)})</p>}
            <div className="kv muted">
              <span>Base</span><span>{f.as_of} · acumulado {usd(f.month_to_date)} · {f.remaining_days} días restantes</span>
              <span>Método</span><span>{f.method.name} (ventana {f.method.window_days} d, media {usd(f.method.daily_mean)}/día, σ {usd(f.method.daily_stdev)})</span>
            </div>
            <details><summary>Supuestos</summary><ul>{f.assumptions.map((a: string) => <li key={a}>{a}</li>)}</ul></details>
          </>)}
        </section>
      </div>

      <section className="card" aria-labelledby="h-an">
        <h2 id="h-an">Anomalías detectadas</h2>
        {anomalies.error && <p className="err">{anomalies.error}</p>}
        {anomalies.data?.length === 0 && <p className="muted">Sin anomalías.</p>}
        <table>
          <thead><tr><th>Fecha</th><th>Serie</th><th className="num">Observado</th><th className="num">Esperado</th><th>Explicación y método</th></tr></thead>
          <tbody>{anomalies.data?.map((a) => (
            <tr key={a.series + a.date}>
              <td>{a.date}</td><td><span className="badge bad">{a.series}</span></td>
              <td className="num">{usd(a.observed)}</td><td className="num">{usd(a.expected)}</td>
              <td>{a.explanation}<div className="muted">{a.method.name} · ventana {a.method.window_days} d · umbral {a.method.threshold}</div></td>
            </tr>))}</tbody>
        </table>
      </section>
    </>
  );
}
