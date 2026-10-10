# Security design: read-only analysis, dry-run, human approval

Each control below names the code that enforces it and the test that proves it.

| Control | Enforced in | Test |
|---|---|---|
| Analysis never writes to the cloud: `simulate` nodes return a plan (`dryRun: true`, `planHash`) and have no access to the `cloud` connector | `Engine.execute` (`simulate`) | `pauses for approval; nothing is applied before a human decides` |
| A destructive node (`apply_plan`) cannot be **published** unless a `simulate` node and an `approval` node for the same plan precede it | `validateDefinition` | `publish rejects destructive nodes without simulate + approval` |
| Even if a definition is bypassed, the destructive step re-checks at run time that an **approved** decision exists for the **exact plan hash** | `Engine.assertApproved` | `destructive step refuses to run if the approved plan differs` |
| Approver must hold the required role, belong to the same org, and (by default) not be the requester | `Engine.decide` | `approval authorisation: role, tenant, self-approval` |
| Published workflow versions are immutable and content-hashed | `Engine.publish` (`deepFreeze`, duplicate check) | `published versions are immutable` |
| Idempotency: triggers dedupe on `eventId`; every step passes a stable `idempotencyKey` (`executionId:nodeId`) to connectors, reused across retries | `Engine.start`, `Engine.runStep` | `trigger events are idempotent`, `retries ... deduplicated` |
| Multi-tenant isolation, layer 1: every store read/write is keyed by `orgId` | `MemoryStore`, `PgStore` | `tenant isolation` |
| Multi-tenant isolation, layer 2: PostgreSQL row-level security on every tenant table; the app role has no `BYPASSRLS` and each transaction sets `app.org_id` | `db/schema.sql`, `PgStore.tx` | `postgres: full approval flow, RLS isolation, immutable audit` |
| The organisation of a request comes only from the verified JWT, never from request parameters | `AuthGuard` | `tenant isolation over the API` |
| JWT: HS256 only (rejects `alg: none`), constant-time signature check, expiry required, secret >= 16 chars or the server refuses to authenticate | `verifyJwt`, `AuthGuard` | `authentication: missing, forged and expired tokens are rejected` |
| Audit entries are append-only: a DB trigger rejects UPDATE/DELETE | `db/schema.sql` (`forbid_audit_change`) | `postgres: ... immutable audit` |
| Concurrent decisions on one approval: exactly one wins (atomic check-and-set; `SELECT ... FOR UPDATE` in Postgres) | `Store.update`, `Engine.decide` | `postgres: concurrent approvals — exactly one decision wins` |
| The AWS Cost Explorer connector can only call `get_cost_and_usage` (method allow-list over the client) | `connectors/aws_ce.py` | `test_client_is_read_only` |
| Decisions cannot be replayed; approver role, tenant and separation of duties are enforced by the engine behind the REST endpoint | `Engine.decide`, `EngineErrorFilter` (403/404/400) | `workflow pauses for approval; only an authorised other user can approve...` |
| Cloud credentials: the analysis role is read-only; the remediation role is a separate role, disabled by default, limited to `ec2:DeleteVolume` on volumes tagged `cloudforge:approved-for-deletion`, with ExternalId | `infra/terraform/main.tf` | `terraform validate` in CI |
| Secrets live outside workflow definitions (`credentialRef`), resolved at run time, masked in step logs, errors and audit | `redact`, `Engine.secrets` | `secrets are masked in logs and audit` |
| AI nodes: strict schema, no extra properties, output/prompt size caps, call budget; failure is closed (step fails) | `validateSchema`, `ai_classify` | `AI node output must satisfy the schema` |
| Webhooks: https only, org host allowlist (from connector config, never from event data), all resolved IPs must be public, no URL credentials | `assertSafeWebhook` | `webhook SSRF guard` |

## Least privilege (connector contract)

* **Analysis credentials**: read-only (e.g. AWS `ce:Get*`, `cur:Describe*`, `ec2:Describe*`). They are never given to `apply_plan`.
* **Remediation credentials**: a separate `credentialRef` with narrowly scoped permissions, attached only to the `apply_plan` node.

## Known limits (be honest)

* There is **no real cloud connector**. The API ships a *demo* `apply` connector that records the remediation and never calls a cloud provider; the Terraform roles show the intended permissions. The webhook DNS check runs before the request; a production HTTP client must pin the resolved IP to avoid DNS-rebinding.
* Organisation rows are created lazily from the token issuer's claims; user/membership management and the JWT issuer are out of scope (tokens are minted with `npm run token`).
* Idempotency of the external side effect relies on the connector honouring `idempotencyKey`. A crash between the cloud call and persisting the step result can re-invoke the connector with the same key.
* The dev `docker-compose.yml` uses hard-coded database passwords; the images could not be built in the authoring environment (no Docker daemon).
