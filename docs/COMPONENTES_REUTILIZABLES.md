# Componentes reutilizables

*Nexus Security & AI Lab.* Piezas de CloudForge FinOps que sirven a otros productos del laboratorio. Ninguna depende de un
cliente, de datos reales ni de credenciales; se documentan aquí para reutilizarlas sin acoplarlas a este producto.

| Componente | Ruta | Qué ofrece | Dependencias | Cómo reutilizarlo |
|---|---|---|---|---|
| Motor de flujos con compuerta de aprobación | `engine/src/engine.js` | Pasos duraderos, reintentos con backoff, timeouts, idempotencia por evento y por paso, versiones inmutables, aprobación humana ligada al hash del plan, auditoría | Ninguna (Node ≥ 20); `pg`/`bullmq` solo en los adaptadores | Importar `Engine` + un almacén (`MemoryStore` o `PgStore`) e inyectar `connectors` propios; la regla "nada destructivo sin simulación + aprobación" la impone `validateDefinition` |
| Almacén PostgreSQL con RLS por organización | `engine/src/pg-store.js`, `db/schema.sql` | Aislamiento multi-tenant por fila (`app.org_id`), auditoría inmutable, `update` atómico con bloqueo de fila | `pg` | Copiar la tabla `engine_documents` y sus políticas; el rol de aplicación no debe tener `BYPASSRLS` |
| Cola de ejecuciones | `engine/src/queue.js` | Adaptador BullMQ con `jobId` determinista (encolado idempotente) y reanudación tras reinicio | `bullmq`, Redis | Pasar una conexión `ioredis`; los trabajos solo llevan ids, nunca secretos |
| Guardias de seguridad | `engine/src/guards.js`, `engine/src/util.js` | Anti-SSRF para webhooks (https, lista blanca, IPs públicas), validador de esquema estricto para salidas de IA, enmascarado de secretos | Ninguna | Funciones puras e independientes |
| Núcleo analítico de costos | `analytics/cloudforge_analytics/` | Ingesta CSV con trazabilidad, anomalías (mediana + MAD), pronóstico con intervalos, presupuestos con estado, variación mes contra mes | Ninguna (Python ≥ 3.11); FastAPI solo en `api.py` | Importar los módulos; todas las salidas explican método y supuestos |
| Contrato de proveedor cloud | `api/src/provider.ts` | Interfaz `CloudProvider` (lectura de solo lectura + borrado con credencial acotada e idempotente) con dos implementaciones | Ninguna | Implementar `billingCsv`, `deleteResource` y, si el proveedor no factura por recurso, `recommendations` |
| Proveedor simulado LocalCloud | `providers/localcloud/` | API local gratuita con token de lectura y token de escritura acotado, para probar remediaciones sin nube real | Ninguna | `node providers/localcloud/server.mjs` con dos tokens distintos |
| Dataset sintético con verdad de referencia | `datasets/` | Generador determinista de facturación, anomalías inyectadas y presupuestos con resultados esperados | Ninguna | Cambiar las constantes del generador |

Reglas para reutilizar: no copiar `datasets/` con datos reales, no copiar credenciales, y mantener el rol de aplicación de la base
de datos sin privilegios de superusuario.
