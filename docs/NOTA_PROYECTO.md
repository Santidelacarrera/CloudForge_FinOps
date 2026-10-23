# Nota del proyecto: CloudForge FinOps

**Organización:** Nexus Security & AI Lab · **Propietario:** Santiago · **Costo:** $0 (todo local, ningún servicio de pago)
**Rama de trabajo:** `feat/cloudforge-finops-autonomo-2026-10-12` · **Rama base:** `main`
**Estado de aprobación:** pendiente de aprobación humana. Esta sesión no modifica `aprobado_santiago` ni `aprobado_sistema`.

## Tareas de esta sesión

| # | Tarea | Estado | Evidencia |
|---|---|---|---|
| 1 | Terminar el modelo de costos con datos simulados | Hecho | Presupuestos con alcance y estado (`budget.py`), variación mes contra mes (`variance.py`), asignación y cobertura de etiquetas, anomalías y pronósticos persistidos, disparador `budget.threshold`. Pruebas: `analytics/tests/test_costmodel.py` (11) y `api/test/costmodel.test.ts` (8). Datos: `datasets/budgets.json` |
| 2 | Pruebas | Hecho | Resultados abajo (28 + 20 + 19 + 3 pruebas en verde) |
| 3 | Documentación | Hecho | `README.md` (instalación, pruebas, uso, modelo de costos), `docs/SECURITY.md`, `docs/COMPONENTES_REUTILIZABLES.md`, esta nota |
| 4 | Sin llamadas a nube real | Cumplido | Las pruebas usan LocalCloud y un mock de Cloudflare locales. La única URL externa del código es el endpoint por defecto de Cloudflare (`api/src/cloudflare.ts`, `scripts/cloudflare-smoke.mjs`), que solo se usa si el propietario define `PROVIDER_KIND=cloudflare` y un token; no se ejecutó en esta sesión |

## Definición de terminado

| # | Condición | Evidencia (comando → resultado) |
|---|---|---|
| 1 | Tareas cumplidas con evidencia | Tabla anterior |
| 2 | Pruebas automatizadas | `python3 -I -m unittest discover -s analytics/tests` → `Ran 28 tests … OK` · `cd engine && npm test` → `tests 20, pass 20, fail 0` · `cd api && npm test` → `tests 19, pass 19, fail 0` (Postgres, Redis y FastAPI reales) · `node --test providers/localcloud/localcloud.test.mjs` → `tests 3, pass 3` |
| 3 | Seguridad y lint | `ruff check analytics datasets` → `All checks passed!` · `bandit -q -r analytics/cloudforge_analytics datasets` → sin hallazgos (salida vacía, código 0) · `npm audit --audit-level=high` en `engine`, `api` y `web` → `found 0 vulnerabilities` (los tres) · `npx tsc --noEmit` en `api` y `web` → sin errores · `npm run build` en `web` → compila |
| 4 | README reproducible | `README.md`, secciones "Ejecutar" y "Tests, lint y seguridad" |
| 5 | Bitácora de decisiones | Sección siguiente |
| 6 | Pendientes para Santiago | Sección siguiente |

Comprobación adicional: `python3 datasets/generate_dataset.py` no modifica `sample_billing.csv` ni `ground_truth.json` (el CI vigila lo mismo).

## Bitácora de decisiones

| Fecha | Decisión | Motivo |
|---|---|---|
| 2026-10-13 | Mantener la rama con el nombre indicado (`…-2026-10-12`) aunque hoy sea 13 | La instrucción fija el nombre; cambiarlo rompería la convención |
| 2026-10-13 | Presupuestos con alcance (total, proyecto, servicio, entorno) en vez de un único total | Un presupuesto global no permite detectar qué servicio se desvía; el esquema solo necesitó 3 columnas nuevas |
| 2026-10-13 | Estado `exceeded / at_risk / watch / ok` basado en gasto real y en el intervalo del pronóstico | Evita decir "todo bien" cuando la proyección ya supera el presupuesto y evita promesas absolutas; la salida incluye método y supuestos |
| 2026-10-13 | Variación mes contra mes en **periodo equivalente** (días 1..N de ambos meses) | Comparar un mes parcial con uno completo produciría falsas caídas |
| 2026-10-13 | Asignación por la etiqueta `owner`; sin etiqueta o proyecto `unassigned` = "sin asignar", con porcentaje de cobertura | Hace visible cuánto del gasto no se puede atribuir, que es el primer paso del showback |
| 2026-10-13 | Anomalías como entidades con id determinista y ciclo `open → acknowledged`; pronósticos como snapshots auditables | El modelo de datos del enunciado las define como entidades; el reconocimiento sobrevive a nuevas detecciones y los disparadores usan solo las abiertas |
| 2026-10-13 | `budget.threshold` como segundo tipo de disparador con `eventId = presupuesto+umbral` | Conecta el modelo de costos con la automatización; los ids deterministas evitan ejecuciones repetidas |
| 2026-10-13 | `budgets.json` añadido al generador **sin consumir números aleatorios** | El CSV debe seguir idéntico (CI lo verifica) y las pruebas existentes no se tocan |
| 2026-10-13 | Las pruebas recalculan sus expectativas desde el CSV crudo con código independiente | Un test que usa la misma función que prueba no demuestra nada |
| 2026-10-13 | Tests con un bug propio (CSV con `\r\n`) corregidos en la prueba, no en el código | La causa raíz era el parser de la prueba; el valor devuelto por la API era correcto (verificado en la base de datos) |
| 2026-10-13 | `_to_delete/aws-terraform/` y `_to_delete/dump.rdb` en vez de borrar | Regla de no borrar definitivamente. El ejemplo de AWS está obsoleto (Santiago no usa AWS); `dump.rdb` era un volcado de Redis de mis pruebas que quedó versionado por error |
| 2026-10-13 | Ruff (E,F,W,B,UP,S) y bandit en CI; corregido `Decimal` sin importar en anotaciones y `raise … from` | Eran avisos reales (F821, B904), no se silenciaron reglas; solo `random` del generador sintético lleva `nosec` con motivo |
| 2026-10-13 | No se construyen imágenes Docker ni se llama a ninguna nube | Sin daemon Docker en el entorno; regla de no usar nube real |

## Pendientes para Santiago

1. **Aprobar o rechazar el PR** (no hacer merge sin tu aprobación).
2. **Validar el adaptador de Cloudflare con tu token de solo lectura:** `CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_READ_TOKEN=… node scripts/cloudflare-smoke.mjs`. Solo hace GET. Requiere crear dos tokens (lectura y edición de Workers KV); eso es una credencial real y queda fuera de lo que esta sesión puede hacer.
3. **Construir las imágenes Docker** (`docker compose build`): no hay daemon Docker en el entorno de desarrollo y el CI no las construye.
4. **Decidir si hay que borrar definitivamente `_to_delete/`** (ejemplo AWS y `dump.rdb`).
5. Decisiones de producto abiertas: emisor de JWT y gestión de usuarios (hoy `npm run token` acuña tokens de desarrollo), conector LLM para el nodo `ai_classify`, y flujos con ramas.

## Riesgos conocidos

* El adaptador de Cloudflare solo se probó contra un mock del formato de la API, no contra Cloudflare.
* El conector que aplica cambios (borrado) solo se ejecutó contra LocalCloud; con un proveedor real habría que revisar idempotencia y permisos.
* Los tipos de cambio los aporta quien importa; no hay servicio de divisas ni prorrateo de presupuestos anuales.
* Las proyecciones suponen ruido diario independiente y gasto estable (el pronóstico lo declara en sus supuestos); no sirven con lanzamientos o cambios de precios previstos.
* La heurística de recursos huérfanos se basa en etiquetas y proyecto faltantes, no en prueba de no uso; por eso la aprobación humana es obligatoria.
* `main` se creó en la sesión anterior como un commit raíz vacío para poder abrir el primer PR; el historial tiene un commit duplicado (el árbol es correcto).
