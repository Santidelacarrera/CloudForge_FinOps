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
| Proveedores | Cloudflare (Workers KV, adaptador) y LocalCloud (desarrollo); contrato común `CloudProvider` | `api/src/cloudflare.ts`, `api/src/provider.ts` |
| Proveedor cloud de desarrollo | LocalCloud: API HTTP gratuita y local con facturación, recursos, token de solo lectura y token de escritura acotado | `providers/localcloud/` |
| Infraestructura | Docker Compose (dev). Ejemplo opcional de roles de mínimo privilegio para AWS en Terraform (no se usa) | `docker-compose.yml`, `infra/examples/aws-terraform/` |

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
* **Recomendaciones y simulación**: heurística de recursos huérfanos con evidencia; `simulate` genera un plan estilo Terraform (`1 to destroy`), ahorro **bruto**, riesgos y supuestos, sin ningún acceso al proveedor.
* **Motor**: versiones inmutables, reintentos con backoff, timeouts, idempotencia por evento y por paso, aprobación ligada al hash del plan, enmascarado de secretos, nodos IA con esquema estricto, guardia SSRF. Cola BullMQ con `jobId` determinista.
* **Seguridad**: ver [docs/SECURITY.md](docs/SECURITY.md) (cada control con su código y su test).
* **Disparadores automáticos**: un flujo con `trigger.type: anomaly.detected` (y filtro por serie/importe/dirección) se inicia solo tras cada importación; `eventId = serie+fecha`, así reimportar no repite ejecuciones. También `POST /api/v1/triggers/evaluate`.
* **Proveedor cloud + conector** (`providers/localcloud/`, `api/src/provider.ts`): LocalCloud es una API gratuita que corre en local y aplica los controles de un proveedor real: token de **solo lectura** para facturación/recursos y un token de **escritura acotado** que solo puede etiquetar `cloudforge:approved-for-deletion` y borrar recursos con esa etiqueta y sin adjuntar, con `Idempotency-Key`. `POST /api/v1/connectors/sync` importa su facturación con el token de lectura; `apply_plan` borra de verdad el recurso con el token de escritura (referenciado por `credentialRef`, nunca visible en estado ni auditoría). Probado de extremo a extremo: no hay ninguna llamada de escritura antes de la aprobación, se borra solo el recurso aprobado y una segunda ejecución falla sin reintentos.
* **Dataset sintético** (`datasets/`) con anomalías controladas (`ground_truth.json`) y ejemplos de flujos en `examples/workflows/` (JSON y YAML).

## Cloudflare (plan gratuito)

Adaptador `CloudflareProvider` para **Workers KV**: detecta namespaces **sin ninguna clave** (recomendación de borrado con evidencia), genera el plan dry-run, espera la aprobación humana y solo entonces borra con un token de escritura distinto.

1. Crea **dos API tokens** en Cloudflare, ambos limitados a tu cuenta: uno con `Workers KV Storage: Read` y otro con `Workers KV Storage: Edit`.
2. Variables: `PROVIDER_KIND=cloudflare`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_READ_TOKEN`, `CRED_CRED_REMEDIATION_SCOPED=<token Edit>`.
3. **Valida primero en solo lectura** (solo hace GET): `CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_READ_TOKEN=... node scripts/cloudflare-smoke.mjs`.

Qué es real y qué no:
* **No verificado contra la API real de Cloudflare**: desde el entorno de desarrollo no hay acceso a `api.cloudflare.com` ni a su documentación. El adaptador sigue el formato de la API que conozco y se probó contra un mock (`providers/cloudflare-mock/`, no es Cloudflare). El script de humo existe precisamente para comprobarlo.
* El plan gratuito **no tiene facturación**: el ahorro es 0 USD (higiene de inventario) salvo que fijes `CLOUDFLARE_KV_EST_USD_PER_DAY` (estimación explícita por namespace y día); `connectors/sync` importa esas filas estimadas.
* Los tokens de Cloudflare no admiten condiciones por etiqueta, así que no existe la guarda del proveedor de LocalCloud; el adaptador **vuelve a comprobar que el namespace sigue vacío justo antes de borrar** y la aprobación humana es el control principal.
* Solo Workers KV; Workers, R2, D1 y DNS no están implementados.

## Limitaciones

* **Ningún proveedor real probado en vivo.** LocalCloud funciona de verdad pero es local; el adaptador de Cloudflare solo se probó contra un mock (ver sección Cloudflare). Sin `PROVIDER_URL`/`PROVIDER_KIND`, `apply_plan` corre en modo *demo* (registra y no llama a nada).
* Los flujos son cadenas lineales (sin ramas). Solo hay disparador por anomalía (no por presupuesto).
* El nodo `ai_classify` falla cerrado si no hay conector LLM configurado; el API no incluye ninguno.
* Las anomalías y pronósticos se calculan bajo demanda; no se persisten como entidades.
* No hay gestión de usuarios ni emisor JWT (los tokens se acuñan con `npm run token`); no hay almacenamiento de objetos en uso (los CSV se guardan normalizados en PostgreSQL).
* Las imágenes Docker **no se han construido** (sin daemon en el entorno de desarrollo); sí se validó `docker compose config` y los pasos del Dockerfile de la API manualmente. El CI de GitHub no se ha ejecutado todavía.

## Ejecutar

### Con Docker
```bash
export JWT_SECRET=$(openssl rand -hex 24)
docker compose up --build            # UI en :8080, API en :3000
JWT_SECRET=$JWT_SECRET API=http://127.0.0.1:3000 node scripts/seed-demo.mjs   # importa datos, publica el flujo, imprime tokens
# Para sincronizar desde LocalCloud (compose ya lo levanta): POST /api/v1/connectors/sync con un token analyst
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
python3 -I -m unittest discover -s analytics/tests -v   # 16 tests (núcleo y FastAPI)
(cd engine && npm test)                                 # 20 tests (incluye PostgreSQL/BullMQ reales)
(cd api && npm test)                                    # 11 tests e2e: API + Postgres + Redis + FastAPI reales
node --test providers/localcloud/localcloud.test.mjs   # 3 tests del proveedor local
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
