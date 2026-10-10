import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getToken, setToken } from './api';
import { Dashboard } from './Dashboard';
import { Recommendations } from './Recommendations';
import { Workflows } from './Workflows';
import { Approvals } from './Approvals';
import './styles.css';

const TABS = { dashboard: 'Panel financiero', recs: 'Recomendaciones', workflows: 'Flujos', approvals: 'Aprobaciones' } as const;
type Tab = keyof typeof TABS;

function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [token, setTok] = useState(getToken());
  return (
    <>
      <header>
        <h1>CloudForge FinOps</h1>
        <nav aria-label="Secciones">
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>{TABS[t]}</button>
          ))}
        </nav>
        <label className="muted" style={{ marginLeft: 'auto' }}>Token JWT{' '}
          <input type="password" value={token} placeholder="pega un token" onChange={(e) => { setTok(e.target.value); setToken(e.target.value); }} />
        </label>
      </header>
      <main>
        {!token ? <div className="card">Pega un token JWT (<code>npm run token -- usuario org rol1,rol2</code> en <code>api/</code>) para empezar.</div>
          : tab === 'dashboard' ? <Dashboard key={token} />
          : tab === 'recs' ? <Recommendations key={token} />
          : tab === 'workflows' ? <Workflows key={token} />
          : <Approvals key={token} />}
      </main>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
