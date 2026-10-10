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
| Multi-tenant isolation: every store read/write is keyed by `orgId` | `MemoryStore` | `tenant isolation` |
| Secrets live outside workflow definitions (`credentialRef`), resolved at run time, masked in step logs, errors and audit | `redact`, `Engine.secrets` | `secrets are masked in logs and audit` |
| AI nodes: strict schema, no extra properties, output/prompt size caps, call budget; failure is closed (step fails) | `validateSchema`, `ai_classify` | `AI node output must satisfy the schema` |
| Webhooks: https only, org host allowlist (from connector config, never from event data), all resolved IPs must be public, no URL credentials | `assertSafeWebhook` | `webhook SSRF guard` |

## Least privilege (connector contract)

* **Analysis credentials**: read-only (e.g. AWS `ce:Get*`, `cur:Describe*`, `ec2:Describe*`). They are never given to `apply_plan`.
* **Remediation credentials**: a separate `credentialRef` with narrowly scoped permissions, attached only to the `apply_plan` node.

## Known limits (be honest)

* The real connectors (cloud APIs, Postgres, BullMQ/Redis) are not implemented; the engine runs against an in-memory store and injected connectors. The DNS check is done before the request; a production HTTP client must pin the resolved IP to avoid DNS-rebinding.
* Idempotency of the external side effect relies on the connector honouring `idempotencyKey`. A crash between the cloud call and persisting the step result can re-invoke the connector with the same key.
* AuthN/Z (who is `user`) is assumed to be provided by the API layer.
