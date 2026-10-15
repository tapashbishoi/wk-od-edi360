# EDI Workato Portal — Phase 1 Spec

Multi-tenant EDI visibility for **Orderful → Workato → Target (SAP / any ERP)**.
Requirements source: `edi_workato.docx` (PRD v0.1). Sample log: `6235172_170_-1_payload.json`.

This is a separate product from `edi-360-tracking` (Boomi). It may share the same
Postgres database and RabbitMQ broker, but never the same objects:

| Thing | Rule |
| :--- | :--- |
| Tables | every table is prefixed `wk_`, including its own tenants/users |
| Migration ledger | `wk_schema_migrations` (not `schema_migrations`) |
| Queues | `workato_<slug>` and dead-letter `workato_<slug>.dlq` |
| Port / env | API on `3100`; own `.env` at the repo root |

---

## 1. Ingestion

Two modes, chosen per tenant (`wk_tenants.source_mode`), both producing the **same envelope**:

- **push** — Workato POSTs job logs to `POST /api/v1/ingest/workato` (`x-api-key`).
- **poll** — a per-tenant poller calls the Workato Platform API with the tenant's token and a
  per-recipe watermark. *(Not in this slice. Verify the job-detail endpoint returns step-level
  `lines` before building it.)*

```
Workato ──push──▶ API ──validate──▶ publish ──▶ workato_<slug> ──▶ tenant consumer ──▶ wk_source_events
   ▲                  └─invalid──▶ wk_ingest_quarantine            └─poison──▶ workato_<slug>.dlq
   └──poll── poller ──────────────────────────▶ (same envelope)
```

### Envelope (schema_version 1)

```json
{
  "schema_version": 1,
  "event_id": "<uuid, assigned by the platform>",
  "tenant_id": 7,
  "source": "workato",
  "source_mode": "push",
  "received_at": "2026-10-07T12:00:00.000Z",
  "dedup_key": "1897324:j-AbrBGNTG-mGCtRa-CD",
  "job": { "...the Workato job log, unmodified..." }
}
```

### Identity and idempotency

- `dedup_key = account_id + ":" + id` where `id` is the **child** job id. `wk_source_events` is unique on
  `(tenant_id, dedup_key)`, so push and poll can run side by side without duplicates.
- `job_url` carries the parent job id in its path and the child in `?child_job_id=`. Store parent,
  child and `master_job_id`; parse both URL forms (with and without the query).
- A repeat of an already-seen job is accepted and ignored, never an error.

### Validation (quarantine, don't drop)

Required: `id`, `account_id`, `recipe_id`, `status`, `started_at` (ISO-8601), `lines` (array).
Anything failing validation, or attributed to the wrong Workato account, goes to
`wk_ingest_quarantine` with a reason and a `retriable` flag, and is **not** published.
Tenant attribution comes from the API key, never from the body; if the tenant has a
`workato_account_id` configured, a body `account_id` that differs is quarantined as non-retriable.

### Per-customer queue and consumer

- Queue name is **generated** from the tenant slug (`^[a-z][a-z0-9_]{1,40}$`), never typed free-form.
- Declared at readiness time (main queue + DLQ) with identical arguments everywhere, because a
  mismatched redeclare kills the channel.
- One consumer per queue, started/stopped by tenant status. A message that fails twice goes to the DLQ.

---

## 2. Tenant lifecycle

`draft → validation_pending → active ⇄ suspended → offboarded`

- `validation_pending`: ingestion accepted, dashboards hidden.
- Activation requires a passing readiness test: queue declared, API key issued, Orderful credential
  present, at least one sample event ingested. (Orderful connectivity is reported `skipped` until the
  endpoint is verified.)
- Credentials (Orderful key, Workato token) are AES-256-GCM encrypted with `WK_ENCRYPTION_KEY`
  (required; no fallback to the JWT secret), returned masked, never logged.

---

## 3. Normalization (next slice)

### Direction

Match steps whose `adapter_name` **starts with** `orderful_connector_` (the suffix is per connection).

| Orderful operation | Direction |
| :--- | :--- |
| `new_transactions_from_poller_bucket`, `get_record` | inbound |
| `create_record` | outbound |

Both present → `ambiguous`. Per-recipe config (`wk_recipe_configs`) can force direction, document
type and which step carries the payload. Hint only: inbound Orderful steps are 1st–2nd, outbound 3rd+.

### Status

Keep the source status, derive a canonical one, and record the **failing step** as `failure_stage`.
The sample is a `failed` job whose real work succeeded; only `approve_delivery` failed
("already DELIVERED"). That maps to **Warning** with stage `orderful_ack`, not Failed.

### Raw EDI

Deferred enrichment worker (never in the ingest path). Verified from a working Postman call:
`POST https://api.orderful.com/v3/convert`, headers `Accept: application/edi-x12`, `Content-Type: application/json`,
`orderful-api-key`; body is the X12-JSON message itself; 201 returns a JSON array of raw X12 strings. Uses the tenant's key, on the JSON the log already carries (inbound `get_record` output,
outbound `create_record` input). Result stored once, keyed by a hash of the input. Only where the
tenant's payload policy allows. Partner/communication details are cached per tenant with a TTL.

---

## 4. Transaction detail: Orderful → Workato → Target

The detail page is organised as three lanes in business order, not a flat event list.

```
 ┌── Orderful ───────────┐   ┌── Workato ─────────────┐   ┌── Target (SAP/ERP) ────┐
 │ Transaction 861041851 │ → │ Recipe · job j-Abr…    │ → │ Document / status      │
 │ Partner, 850, PO …    │   │ Steps with ✓ / ✗       │   │ (from Workato events   │
 │ ISA/GS control no.    │   │ Failure stage, retries │   │  until SAP is direct)  │
 │ Ack + delivery status │   │ Link to Workato job    │   │                        │
 └───────────────────────┘   └────────────────────────┘   └────────────────────────┘
        raw EDI / JSON viewer · chronological timeline · identifiers (copyable)
```

Outbound reverses the lane order (Target → Workato → Orderful). Each lane shows its own status,
timestamps and elapsed time; the header shows the canonical status and the failure stage.

Data model (next slice): `wk_transactions` (one business transaction), `wk_transaction_stages`
(`stage_type` orderful | workato | target, original and canonical status, timestamps),
`wk_orderful_messages`, `wk_workato_executions`, `wk_erp_records`. Correlation keys: Orderful
transaction id (hub), business number (PO), ISA/GS control numbers, delivery id, Workato job ids,
SAP document id (when known). Late or out-of-order events recompute the timeline.

---

## 5. Build order

1. **Foundation** — tenants, users/roles, API keys, encrypted credentials, audit log, migrations. *(this slice)*
2. **Ingestion** — push endpoint, validation, quarantine, queue provisioning, tenant consumer storing raw events. *(this slice)*
3. Normalization — job parsing, direction, canonical status, recipe config, transactions + stages.
4. Enrichment — Orderful convert, then partner/communication/status refresh.
5. Poll mode, correlation, three-lane detail page, dashboard, search.
6. Alerts, reports, SAP leg (needs sample logs).

## 6. Open items

- Workato transport details: push payload shape from the recipe, or polling endpoint and limits.
- Payload policy: full, redacted, or reference only; raw log currently stored as JSONB, move to
  encrypted object storage before production.
- SAP/outbound sample logs.
- Orderful: per-customer key, webhooks vs polling, rate limits, communication/relationship endpoints.
- SSO/MFA scope, secrets store (KMS/Vault) for production, hosting target.
