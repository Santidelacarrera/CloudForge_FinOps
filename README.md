# CloudForge FinOps

Orquestador de automatización FinOps: convierte datos de facturación cloud en recomendaciones, y las recomendaciones en **acciones verificables** que nunca se aplican sin un plan *dry-run* y una **aprobación humana explícita**.

> **Estado: plataforma funcional de extremo a extremo en desarrollo local** (ingesta → analítica → recomendación → plan dry-run → aprobación humana → ejecución idempotente), con PostgreSQL, Redis/BullMQ y UI reales. Lo que **no** está hecho se lista en [Limitaciones](#limitaciones).

## Capturas

| Panel financiero (totales trazables, pronóstico con intervalo, anomalías con método) | Bandeja de aprobaciones (plan dry-run + historial de pasos) |
|---|---|
| ![Panel](docs/screenshots/dashboard.png) | ![Aprobaciones](docs/screenshots/approvals.png) |
| **Recomendaciones y simulación** | **Editor/visor de flujos** |
| ![Recomendaciones](docs/screenshots/recommendations.png) | ![Flujos](docs/screenshots/workflows.png) |

Generadas con `web/screenshots.mjs` contra la pila real sembrada con el dataset sintético.

## Arquitectura

```mermaid
flowchart LR
  CSV[(CSV de facturación)] --> ING[Ingesta y normalización]
  ING --> DB[(Registros normalizados)]
  DB --> ANA[Analítica: anomalías + pronóstico]
  ANA -->|evento: anomalía / presupuesto| ENG[Motor de flujos]
  ENG --> SIM[Nodo simulate: plan dry-run]
  SIM --> APR{{Bandeja de aprobación}}
  APR -->|aprobado, hash del plan| APPLY[Nodo apply_plan]
  APR -->|rechazado| END[Fin]
  APPLY --> CLOUD[(Cloud, credencial acotada)]
  ENG --> AUD[(Auditoría)]
```

| Capa | Tecnología | Dónde |
|---|---|---|
| Frontend | React + TypeScript (Vite) | `web/` |
| API / control plane | Node.js + NestJS, JWT, multi-tenant | `api/` |
| Motor de ejecución | Node.js + BullMQ + Redis; estado en PostgreSQL | `engine/` |
| Analítica | Python + FastAPI (sin estado) sobre un núcleo Python sin dependencias | `analytics/` |
| Almacenamiento | PostgreSQL 16 con RLS por organización | `db/schema.sql` |
| Infraestructura | Docker Compose (dev); Terraform: roles IAM de mínimo privilegio + bucket | `docker-compose.yml`, `infra/terraform/` |

## Diagrama de estados del motor

```mermaid
stateDiagram-v2
  [*] --> RUNNING: start(eventId idempotente)
  RUNNING --> RUNNING: paso OK / reintento con backoff
  RUNNING --> WAITING_APPROVAL: nodo approval (plan + planHash)
  WAITING_APPROVAL --> RUNNING: decide(approved) por usuario autorizado
  WAITING_APPROVAL --> REJECTED: decide(rejected)
  RUNNING --> FAILED: error permanente o reintentos agotados
  RUNNING --> SUCCEEDED: último paso OK
  REJECTED --> [*]
  FAILED --> [*]
  SUCCEEDED --> [*]
```

El estado se persiste tras cada paso, así que `resume()` tras un reinicio continúa sin repetir pasos ya completados.

## Qué está implementado

* **Ingesta**: CSV, monedas mixtas con tipos de cambio explícitos, duplicados reportados, filas inválidas rechazadas con motivo, recursos sin etiqueta `owner` marcados. Importación idempotente (reimportar no duplica). Cada total devuelve los `record_id` y líneas del CSV origen.
* **Anomalías**: mediana móvil + MAD; cada hallazgo incluye método, ventana, umbral y explicación.
* **Pronóstico**: acumulado + media de la ventana × días restantes, intervalos 80/95 %, supuestos, comparación con presupuesto.
* **Recomendaciones y simulación**: heurística de recursos huérfanos con evidencia; `simulate` genera un plan estilo Terraform (`1 to destroy`), ahorro **bruto**, riesgos y supuestos, sin ningún acceso a la nube.
* **Motor**: versiones inmutables, reintentos con backoff, timeouts, idempotencia por evento y por paso, aprobación ligada al hash del plan, enmascarado de secretos, nodos IA con esquema estricto, guardia SSRF. Cola BullMQ con `jobId` determinista.
* **Seguridad**: ver [docs/SECURITY.md](docs/SECURITY.md) (cada control con su código y su test).
* **Dataset sintético** (`datasets/`) con anomalías controladas (`ground_truth.json`) y ejemplos de flujos en `examples/workflows/` (JSON y YAML).

## Limitaciones

* **Sin conector cloud real.** `apply_plan` usa un conector *demo* que registra la acción y no llama a ningún proveedor. Tampoco hay conectores de lectura de APIs de costes (fase 5): solo CSV.
* Los flujos son cadenas lineales (sin ramas ni disparadores automáticos; se inician por API).
* Las anomalías y pronósticos se calculan bajo demanda; no se persisten como entidades.
* No hay gestión de usuarios ni emisor JWT (los tokens se acuñan con `npm run token`); no hay MinIO/S3 en uso (el bucket de Terraform es solo infraestructura de ejemplo).
* Las imágenes Docker **no se han construido** (sin daemon en el entorno de desarrollo); sí se validó `docker compose config` y los pasos del Dockerfile de la API manualmente. El CI de GitHub no se ha ejecutado todavía.
* Carrera conocida en decisiones de aprobación simultáneas (ver SECURITY.md).

## Ejecutar

### Con Docker
```bash
export JWT_SECRET=$(openssl rand -hex 24)
docker compose up --build            # UI en :8080, API en :3000
JWT_SECRET=$JWT_SECRET API=http://127.0.0.1:3000 node scripts/seed-demo.mjs   # importa datos, publica el flujo, imprime tokens
```
Pega un token (analyst / operator / approver) en la UI.

### Sin Docker (necesita PostgreSQL 16 y Redis)
```bash
psql -U postgres -c 'create database cloudforge' && psql -U postgres -d cloudforge -f db/schema.sql
pip install -r analytics/requirements.txt && (cd analytics && uvicorn cloudforge_analytics.api:app --port 8000) &
export JWT_SECRET=... DATABASE_URL=postgres://cloudforge_app:cloudforge_app@localhost:5432/cloudforge REDIS_URL=redis://localhost:6379
(cd api && npm install && npm run build && npm start) &
(cd web && npm install && npm run dev)
```

### Tests
```bash
export CLOUDFORGE_PG_URL=postgres://cloudforge_app:cloudforge_app@localhost:5432/cloudforge REDIS_URL=redis://localhost:6379
python3 -I -m unittest discover -s analytics/tests -v   # 16 tests (núcleo + FastAPI)
(cd engine && npm test)                                 # 18 tests (16 + PostgreSQL/BullMQ reales)
(cd api && npm test)                                    # 6 tests e2e: API + Postgres + Redis + FastAPI reales
(cd infra/terraform && terraform init -backend=false && terraform validate)
```
Sin `CLOUDFORGE_PG_URL`/`REDIS_URL` los tests de integración se omiten.

## API REST (`/api/v1`, Bearer JWT)

`POST /api/v1/cost-imports` · `GET /api/v1/costs/summary` · `GET /api/v1/forecasts` · `GET /api/v1/anomalies` · `POST /api/v1/workflows` · `POST /api/v1/workflows/{id}/run` · `POST /api/v1/recommendations/{id}/simulate` · `POST /api/v1/approvals/{id}/decision` · `GET /api/v1/executions/{id}` · además: `GET /recommendations`, `GET /workflows`, `GET /approvals`, `GET /executions`, `PUT /budgets/{YYYY-MM}`

## Seguridad

Controles, código que los aplica y el test que los prueba: [docs/SECURITY.md](docs/SECURITY.md).

## Criterios de aceptación del MVP

| Criterio | Evidencia |
|---|---|
| Totales trazables a registros origen | `test_total_is_traceable_to_source_rows` |
| Anomalías/pronósticos muestran método, periodo, incertidumbre | `test_forecast_explains_itself`, `test_detects_exactly_injected_anomalies` |
| Flujo se pausa ante cambio crítico y reanuda tras aprobación | `recovers after worker restart while waiting for approval`; e2e `workflow pauses for approval; only an authorised other user can approve...` |
| Sin cambios en la nube sin validación humana | `pauses for approval…`, `destructive step refuses to run…`, `publish rejects destructive nodes…` |
