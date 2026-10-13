# CloudForge FinOps

*Producto de **Nexus Security & AI Lab**.* Orquestador de automatización FinOps: convierte datos de facturación cloud en recomendaciones, y las recomendaciones en **acciones verificables** que nunca se aplican sin un plan *dry-run* y una **aprobación humana explícita**.

> **Estado: plataforma funcional de extremo a extremo en desarrollo local** (ingesta → analítica → recomendación → plan dry-run → aprobación humana → ejecución idempotente), con PostgreSQL, Redis/BullMQ y UI reales. Lo que **no** está hecho se lista en [Limitaciones](#limitaciones).

## Capturas

| Panel financiero (totales trazables, pronóstico con intervalo, anomalías con método) | Bandeja de aprobaciones (plan dry-run + historial de pasos) |
|---|---|
| ![Panel](docs/screenshots/dashboard.png) | ![Aprobaciones](docs/screenshots/approvals.png) |
| **Presupuestos, asignación y variación** | **Recomendaciones y simulación** |
| ![Presupuestos](docs/screenshots/costmodel.png) | ![Recomendaciones](docs/screenshots/recommendations.png) |
| **Editor/visor de flujos** | |
| ![Flujos](docs/screenshots/workflows.png) | |

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
| Infraestructura | Docker Compose (dev). Costo $0: todo corre en local y no se usa ningún servicio de pago | `docker-compose.yml` |

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
* **Anomalías**: mediana móvil + MAD; cada hallazgo incluye método, ventana, umbral y explicación. Se guardan como **entidades** con id estable y ciclo de vida (`open` → `acknowledged`).
* **Pronóstico**: acumulado + media de la ventana × días restantes, intervalos 80/95 %, supuestos, comparación con presupuesto. Cada pronóstico mostrado se guarda como *snapshot* auditable.
* **Modelo de costos** (ver [sección](#modelo-de-costos)): presupuestos con alcance (total, proyecto, servicio, entorno), estado y umbrales, asignación por propietario/proyecto con cobertura de etiquetas, y variación mes contra mes en periodo equivalente.
* **Recomendaciones y simulación**: heurística de recursos huérfanos con evidencia; `simulate` genera un plan estilo Terraform (`1 to destroy`), ahorro **bruto**, riesgos y supuestos, sin ningún acceso al proveedor.
* **Motor**: versiones inmutables, reintentos con backoff, timeouts, idempotencia por evento y por paso, aprobación ligada al hash del plan, enmascarado de secretos, nodos IA con esquema estricto, guardia SSRF. Cola BullMQ con `jobId` determinista.
* **Seguridad**: ver [docs/SECURITY.md](docs/SECURITY.md) (cada control con su código y su test).
* **Disparadores automáticos**: `anomaly.detected` (filtro por serie/importe/dirección; `eventId = serie+fecha`) y `budget.threshold` (filtro por alcance y umbral mínimo; `eventId = presupuesto+umbral`). Se evalúan tras cada importación y con `POST /api/v1/triggers/evaluate`; los ids deterministas evitan ejecuciones repetidas.
* **Proveedor cloud + conector** (`providers/localcloud/`, `api/src/provider.ts`): LocalCloud es una API gratuita que corre en local y aplica los controles de un proveedor real: token de **solo lectura** para facturación/recursos y un token de **escritura acotado** que solo puede etiquetar `cloudforge:approved-for-deletion` y borrar recursos con esa etiqueta y sin adjuntar, con `Idempotency-Key`. `POST /api/v1/connectors/sync` importa su facturación con el token de lectura; `apply_plan` borra de verdad el recurso con el token de escritura (referenciado por `credentialRef`, nunca visible en estado ni auditoría). Probado de extremo a extremo: no hay ninguna llamada de escritura antes de la aprobación, se borra solo el recurso aprobado y una segunda ejecución falla sin reintentos.
* **Dataset sintético** (`datasets/`) con anomalías controladas (`ground_truth.json`) y ejemplos de flujos en `examples/workflows/` (JSON y YAML).

## Modelo de costos

Todo se calcula sobre los registros normalizados en USD base y puede comprobarse contra el CSV de origen (los tests recalculan las cifras de forma independiente).

| Pieza | Regla | Endpoint |
|---|---|---|
| Presupuesto con alcance | `total`, `project`, `service` o `environment`; mes `YYYY-MM`; umbrales configurables (por defecto 50/80/100 %) | `PUT /api/v1/budgets/{mes}` |
| Estado del presupuesto | `exceeded`: el gasto del mes ya lo supera · `at_risk`: la proyección puntual lo supera · `watch`: solo el límite superior del 95 % lo supera · `ok`: todo el intervalo cabe. Incluye método, intervalo y supuestos | `GET /api/v1/budgets/status?month=&as_of=` |
| Asignación (showback) | Coste por propietario (`owner`) o proyecto; lo que no tiene etiqueta o está en `unassigned` es *sin asignar*; devuelve la **cobertura** (% atribuible) y los registros origen | `GET /api/v1/costs/allocation?by=owner\|project` |
| Variación | Días 1..N del mes frente a los días 1..N del mes anterior (periodo equivalente, nunca un mes parcial contra uno completo) | `GET /api/v1/costs/variance?as_of=` |
| Anomalías | Entidades persistidas; `POST /api/v1/anomalies/{id}/ack` las reconoce y el reconocimiento sobrevive a nuevas detecciones | `GET /api/v1/anomalies` |
| Pronósticos | Cada pronóstico se guarda con método, intervalos y supuestos | `GET /api/v1/forecasts`, `GET /api/v1/forecasts/history` |

Datos simulados (`datasets/`, todo sintético): `sample_billing.csv` (61 días), `ground_truth.json` (anomalías inyectadas) y `budgets.json` (presupuestos de septiembre de 2026 con resultado esperado: p. ej. *Database* en riesgo a mitad de mes y superado a fin de mes). Se regeneran con `python3 datasets/generate_dataset.py`; el CI comprueba que no cambian.

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
* Los flujos son cadenas lineales (sin ramas).
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

### Tests, lint y seguridad
```bash
export CLOUDFORGE_PG_URL=postgres://cloudforge_app:cloudforge_app@localhost:5432/cloudforge REDIS_URL=redis://localhost:6379
python3 -I -m unittest discover -s analytics/tests -v   # 28 tests (núcleo, modelo de costos y FastAPI)
(cd engine && npm install && npm test)                  # 20 tests (incluye PostgreSQL/BullMQ reales)
(cd api && npm install && npm test)                     # 19 tests e2e: API + Postgres + Redis + FastAPI reales
node --test providers/localcloud/localcloud.test.mjs    # 3 tests del proveedor local
(cd web && npm install && npm run build)                # tipado + build de la UI
pip install ruff bandit && ruff check analytics datasets && bandit -q -r analytics/cloudforge_analytics datasets
(cd api && npx tsc --noEmit) && (cd web && npx tsc --noEmit)
for d in engine api web; do (cd $d && npm audit --audit-level=high); done
```
Sin `CLOUDFORGE_PG_URL`/`REDIS_URL` los tests de integración se omiten. Los tests no llaman a ninguna nube real: usan LocalCloud y un mock de Cloudflare locales. Los archivos obsoletos se mueven a `_to_delete/` en lugar de borrarse.

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
