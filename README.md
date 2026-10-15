# EDI360

Multi-tenant EDI visibility for **Orderful → Workato → Target (SAP / any ERP)**.
Separate from `edi-360-tracking` (Boomi): own `wk_` tables, own `wk_schema_migrations` ledger,
queues named `workato_<customer>`, API on port 3100.

Design and scope: [docs/SPEC.md](docs/SPEC.md). Requirements: `edi_workato.docx`.

## Run

```bash
cd backend && npm install
cp ../.env.example ../.env     # fill DATABASE_URL, JWT_SECRET, WK_ENCRYPTION_KEY, RABBITMQ_URL
npm run db:migrate
npm run db:create-admin -- --email=you@company.com
npm run dev
```

`npm test` and `npm run typecheck` need no database or broker.

## Run the UI

```bash
cd frontend && npm install
npm run dev          # http://localhost:5174, proxies /api to the backend on :3100
```

Sign in with the admin you created above. To see the screens with data before real logs arrive:

```bash
cd backend && npm run db:seed-demo             # a "Demo (sample data)" tenant, ~44 jobs over 14 days
cd backend && npm run db:seed-demo -- --remove # delete it again
```

Platform admins pick a tenant from the header; everyone else sees their own. Tenant setup (queue, credentials, API keys,
readiness, quarantine) is under **Tenants**, or **Settings** for a customer admin.

Each transaction page shows three blocks in business order: **Orderful → Workato → Target (ERP)** for inbound, and
**Source (ERP) → Workato → Orderful** for outbound. Every block has its own status; the arrows take the colour of the block they leave.

## Sending logs in

Both routes go through the same validation, quarantine, queue, consumer and normalization. Sending the same job twice
is harmless: it is recognised and ignored.

**1. Drop folder** (on by default outside production; the API must be running)

Drop Workato job-log `.json` files into `ingest-drop/<tenant slug>/`. The folder is created automatically once a tenant is
open for ingestion. A file can hold one job, an array of jobs, or `{"events": [...]}`.

| Where the file ends up | Meaning |
| :--- | :--- |
| `processed/` | Accepted. A `.warnings.txt` beside it lists any events in the file that were quarantined. |
| `failed/` | Rejected (not JSON, or every event refused). A `.error.txt` beside it says why. |
| left in place | Not ready yet (still being copied, tenant not open, or the broker is down). Retried every 5 s. |

**2. API (Postman or Workato)**

```
POST http://localhost:3100/api/v1/ingest/workato
x-api-key: <key from Tenants > your tenant > Ingestion API keys>
Content-Type: application/json

<the Workato job JSON as-is, or an array, or {"events": [...]}>
```

`202 {"accepted":1,"quarantined":[]}` is success. `422` means everything was refused (the body says why), `401` a bad key,
`403` the tenant isn't open for ingestion (draft, suspended or offboarded).

## Signing in

Open http://localhost:5174 and use the admin you created with `npm run db:create-admin`. Lost the password:

```bash
cd backend && npm run db:reset-password -- --email=you@company.com
```

## Onboard a tenant (API)

1. `POST /api/auth/login` → token
2. `POST /api/admin/tenants` `{ "name": "Nordic Naturals", "slug": "nordic_naturals", "workato_account_id": "1897324" }`
3. `PUT  /api/admin/tenants/:id/credentials/orderful` `{ "secret": "..." }`
4. `POST /api/admin/tenants/:id/api-keys` → key shown once
5. `POST /api/admin/tenants/:id/status` `{ "status": "validation_pending" }` → declares `workato_nordic_naturals` + `.dlq`, opens ingestion
6. Send a sample job: `POST /api/v1/ingest/workato` with `x-api-key`
7. `POST /api/admin/tenants/:id/readiness`, then status `active`

## Reading the data

All under `/api/tenants/:tenantId` (any role of that tenant; platform admins too, audited):

- `GET /summary` - totals by canonical status; same filters as the list, so they reconcile
- `GET /transactions?status=&direction=&environment=&documentType=&recipeId=&partner=&from=&to=&q=&limit=&offset=` -
  `q` matches PO, Orderful transaction id, ISA/GS control number, delivery id, or any Workato job id
- `GET /transactions/:id` - the three lanes (Orderful, Workato, Target; reversed for outbound), timeline, executions
- `GET /recipes`, `PUT /recipes/:recipeId` - per-recipe direction / document type override (customer admin); re-normalizes past logs

## Raw EDI (Orderful convert)

Off per tenant until `PATCH /api/admin/tenants/:id {"raw_edi_enabled": true}` and an Orderful credential is set.
A background sweep sends the message JSON from the log to `POST /v3/convert` and stores the X12 encrypted.

- `GET /transactions/:id/raw-edi` - platform admin, customer admin, support only; every read audited
- `POST /transactions/:id/raw-edi/convert` - convert now

## Test EDI generator

Sidebar → **Test files** (platform admin, customer admin, support). Build X12 test files for a trading partner:

1. Pick a saved partner, or enter one ad hoc (presets: blank, Sprouts, Natural Grocers). Partner details: ISA/GS ids on both sides, X12 version 4010/5010, T/P usage, delimiters, product-id order (UP/SK/VP/VN/IN), default parties, terms and per-document rules.
2. Pick a document: 850, 855, 856, 810, 204, 990, 214, 210, 940, 943, 944, 945, 997. The form is built from the document's schema and the file previews live with validation warnings.
3. **Download** takes the partner's next ISA/GS control numbers (atomic, safe under concurrency) and records the file in history. Preview never consumes a number. You can also type control numbers manually.

Partner rules, one per line: `AFTER BEG: REF*DP*3`, `REPLACE ITD: ITD**3***Net`, `REMOVE PER`; `#` starts a note.

Line items accept pasted rows from Excel or a CSV (columns matched by header name). `.xlsx` files are not read directly (the npm `xlsx` package has known vulnerabilities) - save as CSV or paste.

Generated files get an exactly 106-character ISA, correct SE/GE/IEA counts and HL integrity, and are round-tripped through the portal's own parser.

## Partners and EDI flows

Sidebar → **Partners**. A partner appears once its documents arrive (the far end of a transaction, keyed by ISA id). Per partner: whether to track the 997 we send (inbound) and expect a 997 back (outbound), and **Manage EDI Flow** - named, ordered document sequences (850 in → 855/856/810 out) with 1:N, optional, and "late after N minutes" per step. **Track Document Flow** (also on the documents page) follows a PO, shipment, invoice or BOL number across the partner's documents and shows each step as success, failed, awaiting 997, pending, late or skipped.

## My View

**My View** on the documents page: pick partners and, for each, which document types. Lists, the dashboard and exports open on just those. It is a display preference, never an access limit; **Show everything** clears it. Searching an exact number ignores it.

## Explain EDI

On a transaction: **Explain EDI** writes the document in plain language, in one of 12 languages, using the **tenant's own Gemini key** (tenant page). It needs the raw EDI to be converted and is limited to admin and support roles, since the EDI is sent to Google. Results are cached per language, regenerated on request, shown in a script-less sandboxed frame, can be printed to PDF, and are audited. A Google AI Studio key or a Google Cloud API key both work. `GEMINI_MODEL` (default `gemini-2.5-flash`) sets the model.

## Email alerts

**Email Alerts** on the documents page: "mail me when this partner's document of this type succeeds / fails" (any partner or type allowed). Sent through the **tenant's own Brevo account** to your own address. A background sweep (every 30 s, `ALERTS_INTERVAL_MS`) mails each finished transaction at most once per event, retries a failed send twice, and never mails documents that finished before the alert was created. **Send me a test email** checks the Brevo setup. Failure alerts cover Failed and Warning.

## API docs and platform health

Platform admins get **API & health** in the top bar (`/admin/api`):

- **Health**: database, RabbitMQ, migrations, tenant queue consumers, each background worker, and the work waiting (unnormalized events, raw EDI, alert emails, quarantine). Refreshes every 15 s. Read-only, no secrets.
- **API docs (Swagger)**: every endpoint with a Try it out button, signed in as you. Try it out makes real requests, including ones that change data or send email.

Behind it: `GET /api/platform/openapi.json` and `GET /api/platform/health` (platform admin only; the public `GET /api/health` stays for load balancers). The OpenAPI description is the table in `backend/src/docs/openapi.ts`. **When you add a route, add it there**: a test compares the table with the routes the app really serves and fails on any difference.

## Outbound transactions (Source ERP → Workato → Orderful)

A Workato log for a document we SEND (recipe creates a transaction in Orderful) tells us what was sent and the Orderful transaction id, but not whether Orderful accepted it. The portal asks Orderful itself, `GET /v3/transactions/{id}`, with the tenant's own key, on a schedule (every minute while new, then 10 min, then 2 h, up to 3 days, stopping once the outcome is final) and **Refresh from Orderful** on the document does it on demand:

- `validationStatus INVALID` → the Orderful lane and the transaction are **Failed** at "Orderful validation", even though the recipe succeeded. The Workato lane stays green because the recipe did its job.
- `deliveryStatus FAILED` or a partner 997 `REJECTED` → Failed at delivery / acknowledgment.
- Valid but not yet delivered → "Sent to Orderful" (in flight); delivered → Completed.

The exact validation errors are only in Orderful's UI (Rules Editor tab), so failed documents show **Open in Orderful**, linking to `https://ui.orderful.com/transactions/<id>?viewAs=<organisation id>`. Save the organisation id on the tenant page (next to the Orderful key). Raw EDI for an outbound document is converted from the message the recipe sent.

## Which Workato jobs are kept

Workato logs every recipe in the account; the portal keeps only EDI. At ingestion each job is decided in this order: the admin's choice for the recipe (Recipes page: **Auto**, **Always keep**, **Ignore**); a recipe that has shown EDI before (remembered, so its early failures are kept too); an Orderful step in the job; an X12 message or `ISA*` interchange in any step; or EDI / Orderful / X12 in the recipe name, path or job title. Anything else is **ignored**: counted per recipe (shown on the Recipes page), never queued or stored, and answered with 202 `{accepted, ignored}` so Workato does not retry. Size and folder are not used: a tiny failed job must be kept, and folders differ per customer.

A recipe that is a stage of an EDI flow but has no EDI content of its own (for example SAP to a staging file or queue) should be set to **Always keep**. Jobs ignored before that are not recoverable; later ones are kept.

## Tickets and emailed reports

On the documents list (select documents) and on a document page: **Create ticket** and **Send email**. Both need a role that reads documents, except auditors. Neither includes raw EDI.

**Create ticket.** The tenant's admin connects Jira or ServiceNow on the tenant page (Ticketing card): address (https, public internet only; redirects are refused), service account, API token or password (encrypted at rest), and the Jira project key and issue type, or the ServiceNow category and assignment group. **Test connection** reads without creating anything. A person then gives a reason and a priority (critical, high, medium, low); the ticket is filled in from the document: partners, status, where it stopped and why, Orderful and Workato identifiers, business facts and links. Jira gets the priority by the names configured for your project (it still raises the ticket if a name is not valid); ServiceNow gets impact and urgency. Up to 25 documents go into one ticket; 30 tickets an hour per user. Tickets show on the document page.

**Send email.** Not the same as Email Alerts (which a user subscribes to for FUTURE documents): this tells a person about documents that exist now. Choose up to 5 recipients, a subject and an optional message; each gets one HTML report through the tenant's Brevo account, with a business section (document, partners, ship from/to, amounts, references, line items), the three-lane status, and a technical section (Orderful and Workato identifiers, failed steps, links). Replies go to the sender. 20 reports an hour per user; every send is recorded with its recipients.

## Status

Built: foundation, ingestion, normalization, read API, raw EDI conversion, and the UI (login, dashboard, transaction list and
search, three-block detail page, recipes, tenant admin). Not yet: poll mode, Orderful partner/communication enrichment,
alerts, reports and exports, user management screens, the SAP leg (needs sample logs). See docs/SPEC.md section 5.

## 997 reminder rules

Nav: **997 rules** (administrators and support see it; only administrators change rules or send).
A rule says: for this partner (or all), these document types (or all), inbound and/or outbound
(default both), if the 997 is still pending after N hours, email these people (up to 10) at up to
two times a day in the tenant time zone, or only on demand with **Send now**.

- Pending = went through Orderful, the partner's 997 is tracked in that direction (Partners page),
  Orderful has not said ACCEPTED or REJECTED, and the document did not fail validation or delivery.
  Age counts from Orderful's creation time, else when we first saw it. 30-day look-back.
- Before reporting, outbound candidates are re-checked with Orderful (the status sweep stops after 3 days).
- Nothing is sent when nothing is waiting. **Preview** shows the list without sending.
- A scheduled slot is claimed in `wk_ack_rule_runs` (unique per rule and slot), so a restart or a second
  worker never sends the same morning mail twice. A slot is run if its time passed within the last 3 hours;
  a rule made after a slot passed does not fire that slot.
- Sending needs the tenant's Brevo key. On-demand runs: once a minute per rule, 10 an hour per user. Audited.
- Separate from Email Alerts (per-user subscriptions to future documents). Migration `015_ack_rules.sql`.

## Following tickets (Jira / ServiceNow)

Nav: **Tickets**. Every ticket raised from the portal is listed with its latest status, assignee and
priority as last read from Jira or ServiceNow, and the documents it covers. Click one for the detail panel:
comments from both sides, **Open in Jira**, **Post comment**, **Change status** (Jira) and **Refresh**.
The document page shows each ticket with its status; clicking it opens the same panel.

- **Sync is a read:** a worker re-reads unfinished tickets every 5 minutes for the first day, every 30
  minutes for a week, then every 2 hours; finished tickets (Jira status category Done, ServiceNow
  Resolved/Closed/Canceled) stop being polled. Opening or refreshing a ticket reads it immediately, so a
  change made in Jira shows when someone looks. No webhook or inbound port is needed.
- **Writes go to the ticket system:** a comment is posted under the service account, signed
  "Posted from EDI Portal by Name (email)", and read back with its own id; a status change uses the moves
  Jira allows for that ticket right now (its workflow, so only valid moves are offered). Both are audited
  and rate limited (60 an hour per user).
- **ServiceNow:** status, assignee and customer-visible comments are read; comments can be posted; status is
  changed in ServiceNow (the incident state workflow is site specific). Work notes are never read.
- Roles: administrators, support and business; auditors cannot see tickets. A ticket's `status` and
  `synced_at` columns, and `wk_ticket_comments`, are in migration `016_ticket_sync.sql`.

## Assistant (chat)

A chat button on every page. Users ask in plain language; the assistant answers from the portal's own data
and asks when it needs a detail (which partner, which order, how many hours, who to email).

- **Tools, not SQL.** The model (Gemini, the tenant's own key from Explain EDI) never sees the database. It
  calls a fixed set of tenant-scoped tools: `find_documents`, `get_document`, `pending_997`, `list_partners`,
  `list_tickets`, `list_997_rules`, and four `propose_*` tools. Each tool re-checks the caller's role. No tool
  returns raw EDI. Code: `backend/src/services/chat/` (`agent.ts` loop and system prompt, `tools.ts`, `gemini.ts`).
- **It cannot change anything.** `propose_997_rule`, `propose_ticket`, `propose_email_report` and
  `propose_ticket_comment` only return a confirmation card. Pressing Confirm calls the normal portal API
  (`saveAckRule`, `createTicket`, `emailReport`, `commentOnTicket`) with the user's own token, so validation,
  roles, rate limits and audit are exactly those of the screens. Max 3 cards per message.
- **Answers come from tool results.** The prompt forbids guessing, tells it to say "not found" and to ask
  questions, and treats tool output (partner names, ticket comments) as data, never instructions. Links in
  replies are rendered only if they go to a portal page or https.
- **Memory is the open conversation only.** The browser sends the last 20 turns; nothing is stored server
  side except a per-day message counter (`wk_chat_usage`). Audit records which tools ran, not the question.
- **Control.** Tenant settings > Assistant: on/off and messages per day (default `CHAT_DAILY_LIMIT`=300).
  Also 60 messages an hour per user, a 55 s limit per question, and retries when Gemini returns 429.
- **Gemini quota.** A Google Cloud (Vertex) API key can be throttled with 429s; a billing-enabled project or
  an AI Studio key behaves better. Thinking is off (`thinkingBudget: 0`) to keep replies fast.
- Migration `017_chat.sql`.

## EDI360: endpoints, MCP and tracking

**Endpoints (Tenant settings).** A tenant whose source mode is *push* sees its **Workato ingestion endpoint**
(`POST <public address>/api/v1/ingest/workato`, header `x-api-key`) with a copy button, last-received time,
24 hour counts, the latest failure and an example request. The address follows the deployment: set
`PUBLIC_API_URL` on the server (recommended in production); if unset, it is taken from the address the admin is
using (honouring `X-Forwarded-Host/Proto` behind a proxy). Poll-mode tenants see a note instead.

**MCP server.** `POST <public address>/api/mcp`: JSON-RPC 2.0 over HTTP (Streamable HTTP, stateless), read
only. It offers the same lookups as the chat (`find_documents`, `get_document`, `pending_997`, `list_partners`,
`list_tickets`, `list_997_rules`) and never the `propose_` tools. Separate key types, chosen when a key is
created: **Ingestion** keys only work on ingest, **MCP** keys only on MCP (existing keys stay ingestion keys).
An MCP key is sent as `Authorization: Bearer ...` (or `x-api-key`); every call is limited to that key's tenant.
Browser origins are refused, 120 requests a minute per key, `MCP_ENABLED=false` switches it off. The tenant
settings page shows ready-to-copy setup for Claude Code, Claude Desktop (through the `mcp-remote` bridge),
Gemini CLI and a generic client, filled in with the deployment address.

**Tracking (platform admin).** *API & health > Integrations* shows, for the ingestion API, the MCP server and the
assistant: requests, failures and average time in the last 24 hours, per-tenant traffic and keys (flagging a
tenant with no ingest key), recent errors, and the public addresses. Data is `wk_api_activity` (metadata only,
30 days; never request bodies, keys or questions). The Health page also lists `MCP server` and `Public API URL`.

**Name.** The product is EDI360 (the 360 view of every EDI document). Internal names (`wk_` tables, `wk_live_`
key prefix, the `edi-portal` Jira label) are unchanged on purpose so nothing existing breaks.

Migration `018_mcp_activity.sql`.

### Choosing the assistant's AI model

Tenant settings > Assistant: **AI model provider** is Google Gemini (default), OpenAI or Anthropic Claude, with an
optional model name (defaults `gemini-2.5-flash`, `gpt-4o-mini`, `claude-sonnet-5-5`; `OPENAI_MODEL`,
`ANTHROPIC_MODEL`, `OPENAI_API_URL`, `ANTHROPIC_API_URL` change the defaults). Each organisation saves its own key
for the provider it picks (Connections card). The assistant, its tools and confirmation cards are the same on all
three: `services/chat/providers.ts` translates the conversation to and from each provider's API.

**Time budget.** A question has 60 seconds in total. Every model call gets only the time left (max 30 s), a call
that cannot finish is not started, and rate-limit retries only happen while there is time. A slow or throttled
provider therefore ends in a clear message before the browser's 90 s limit, instead of a bare timeout.

### One model for the chat and Explain EDI, and what it costs

The provider and model chosen under Tenant settings > **AI model (assistant and Explain EDI)** drive both the chat
and Explain EDI (`explain.service.ts` now goes through the same provider layer; there is no separate Gemini-only
path). An explanation is saved per document and language against a hash of the EDI, so opening it again costs
nothing: the model is called only the first time, or on Refresh.

**Real usage and cost.** Every chat question and every new explanation records the provider's own token counts
(input, output, cached) and the cost at the price then, in `wk_api_activity` (`cost_usd`; counts only, never
the question, the EDI or the answer). Prices are the standard OpenAI rates in `services/chat/pricing.ts`
(source: developers.openai.com/api/docs/pricing); a model with no price on file (Claude, Gemini, anything new)
shows tokens only and is flagged "not priced" rather than $0. Add prices with `CHAT_PRICES_JSON`, for example
`{"claude-sonnet-5-5":{"input":3,"output":15}}` (per 1M tokens).

- Platform admin > API & health > Integrations: Explain EDI tile, 24 h tokens and cost, and a table of 30 day
  chat questions, explained documents, tokens and cost per tenant.
- Tenant settings > AI model: that organisation's own last 30 days.
- gpt-5 models are asked for minimal thinking (`reasoning_effort: minimal`; o-series `low`), with a retry
  without it if the model rejects the setting, and 4096 output tokens so thinking cannot crowd out the answer.
