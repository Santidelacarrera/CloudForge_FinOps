// Captures README screenshots from a running, seeded stack (web on :5173).
import { chromium } from 'playwright-core';
import { token } from '../scripts/seed-demo.mjs';

const executablePath = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const shot = async (role, tab, name, act) => {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: 'light' });
  await ctx.addInitScript((t) => sessionStorage.setItem('cf_token', t), role);
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:5173/');
  await page.getByRole('button', { name: tab }).click();
  await act?.(page);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `../docs/screenshots/${name}.png`, fullPage: true });
  await ctx.close();
};
await shot(token('ana', ['analyst']), 'Panel financiero', 'dashboard', async (p) => { await p.getByLabel('Fecha de corte del pronóstico').fill('2026-09-15'); await p.waitForTimeout(800); });
await shot(token('ana', ['analyst']), 'Presupuestos y asignación', 'costmodel', async (p) => { await p.getByLabel('Fecha de corte', { exact: true }).fill('2026-09-15'); await p.waitForTimeout(1200); });
await shot(token('ana', ['analyst', 'operator']), 'Recomendaciones', 'recommendations', async (p) => { await p.getByRole('button', { name: /Simular/ }).click(); await p.waitForSelector('pre'); });
await shot(token('dev', ['operator']), 'Flujos', 'workflows');
await shot(token('fin', ['approver']), 'Aprobaciones', 'approvals', async (p) => { await p.getByRole('button', { name: 'Ver pasos' }).first().click(); await p.waitForSelector('[aria-label="Historial de pasos"]'); });
await browser.close();
