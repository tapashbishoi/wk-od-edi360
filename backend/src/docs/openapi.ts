/**
 * The API described for Swagger UI (served to platform admins at /api/platform/openapi.json).
 *
 * Written by hand as a table of endpoints and turned into OpenAPI 3 below. A test compares this table
 * with the routes the app really serves, so an endpoint added without documenting it, or documented
 * after it was removed, fails the build instead of quietly drifting.
 */

type Auth = 'bearer' | 'apiKey' | 'none';

interface Endpoint {
  m: 'get' | 'post' | 'put' | 'patch' | 'delete';
  p: string;
  tag: string;
  s: string;
  d?: string;
  auth?: Auth;
  /** Who may call it, in words */
  roles?: string;
  /** Query parameters: name -> description */
  q?: Record<string, string>;
  /** Example request body */
  body?: Record<string, unknown>;
  /** Success status, default 200 */
  ok?: number;
  /** Response is a file download */
  file?: string;
}

const ADMIN = 'platform admin';
const MEMBER = 'any member of the tenant';
const CONFIG = 'platform admin, customer admin, support';
const PAYLOAD = 'platform admin, customer admin, support (business and auditor are refused)';

const LIST_FILTERS: Record<string, string> = {
  q: 'Exact PO / shipment / invoice / BOL number, Orderful id, ISA/GS control number, or Workato job id',
  status: 'One canonical status or several, comma-separated (e.g. Failed,Warning)',
  direction: 'inbound | outbound | ambiguous | unknown',
  environment: 'test | production | unknown',
  documentType: 'X12 transaction set, e.g. 850',
  partner: 'Partner name (substring) or ISA id',
  recipeId: 'Workato recipe id',
  from: 'ISO date, last activity on or after',
  to: 'ISO date, last activity on or before',
  view: 'My View filter: ISA1:850,860|ISA2 (what the portal sends for the signed-in user)',
};

export const ENDPOINTS: Endpoint[] = [
  // ---------------------------------------------------------------- health
  { m: 'get', p: '/health', tag: 'Health', s: 'Liveness and database check', d: 'Public. Returns 503 when the database is unreachable. Used by load balancers.', auth: 'none' },

  // ---------------------------------------------------------------- auth
  { m: 'post', p: '/auth/login', tag: 'Auth', s: 'Sign in', d: 'Returns a bearer token. 401 for any bad email/password; 403 (after a correct password) if the organisation is suspended.', auth: 'none', body: { email: 'user@example.com', password: 'string' } },
  { m: 'get', p: '/auth/me', tag: 'Auth', s: 'The signed-in user, their tenant and My View', roles: 'any signed-in user' },
  { m: 'put', p: '/auth/me/saved-view', tag: 'Auth', s: 'Save My View', d: 'Only ever the caller\'s own view. Malformed pairs are dropped.', roles: 'any signed-in user', body: { savedView: [{ partner: 'ISAID', types: ['850'] }] } },
  { m: 'get', p: '/help/user-guide.pdf', tag: 'Help', s: 'The EDI360 user guide (PDF)', d: 'Streams the guide shown on the Help page.', roles: 'any signed-in user' },
  { m: 'get', p: '/auth/invite/{token}', tag: 'Auth', s: 'What an invitation link is for', d: 'Public. Returns no secrets; 404 for any invalid, used or expired token.', auth: 'none' },
  { m: 'post', p: '/auth/accept-invite', tag: 'Auth', s: 'Accept an invitation and set a password', auth: 'none', body: { token: 'string', password: 'at least 10 characters' } },

  // ---------------------------------------------------------------- ingest
  { m: 'post', p: '/v1/ingest/workato', tag: 'Ingest', s: 'Push Workato job logs', d: 'Accepts one job, an array, or {jobs:[...]}. Valid jobs are published to the tenant queue; invalid or wrong-account jobs are quarantined. Idempotent on account:job id. Authenticated by the tenant API key, not a bearer token.', auth: 'apiKey', roles: 'tenant API key', ok: 202, body: { job_id: 'j-AbrCCwtT-WpPfM6-CD', recipe_id: '82858874', status: 'succeeded' } },

  // ---------------------------------------------------------------- tenant data
  { m: 'get', p: '/tenants/{tenantId}/summary', tag: 'Transactions', s: 'Dashboard totals', d: 'Counts by canonical status for the same filters as the list.', roles: MEMBER, q: LIST_FILTERS },
  { m: 'get', p: '/tenants/{tenantId}/trend', tag: 'Transactions', s: 'Daily volume and failures', roles: MEMBER, q: { days: 'How many days back', environment: 'test | production | unknown', view: LIST_FILTERS.view } },
  { m: 'get', p: '/tenants/{tenantId}/transactions', tag: 'Transactions', s: 'Search and list EDI documents', roles: MEMBER, q: { ...LIST_FILTERS, ids: 'Hand-picked ids, comma-separated (max 500)', limit: 'Page size', offset: 'Page offset' } },
  { m: 'get', p: '/tenants/{tenantId}/export/transactions.csv', tag: 'Transactions', s: 'Export the filtered list as CSV', d: 'Cells that could run as spreadsheet formulas are neutralised.', roles: MEMBER, q: { ...LIST_FILTERS, ids: 'Hand-picked ids, comma-separated' }, file: 'text/csv' },
  { m: 'get', p: '/tenants/{tenantId}/transactions/{id}', tag: 'Transactions', s: 'One document: the three lanes, business details and executions', roles: MEMBER },
  { m: 'get', p: '/tenants/{tenantId}/transactions/{id}/raw-edi', tag: 'Raw EDI', s: 'Read the converted raw EDI', d: 'Audited, platform admins included.', roles: PAYLOAD },
  { m: 'post', p: '/tenants/{tenantId}/transactions/{id}/raw-edi/convert', tag: 'Raw EDI', s: 'Convert now through Orderful /v3/convert', roles: PAYLOAD },
  { m: 'post', p: '/tenants/{tenantId}/transactions/{id}/orderful-status/refresh', tag: 'Transactions', s: 'Check a sent transaction with Orderful now', d: 'GET /v3/transactions/{id} with the tenant\'s own key: validation, delivery and acknowledgment status. Outbound only; the background sweep does this on a schedule.', roles: CONFIG },
  { m: 'get', p: '/tenants/{tenantId}/transactions/{id}/explain', tag: 'Explain EDI', s: 'Plain-language explanation of the document', d: 'Uses the tenant\'s own Gemini key. Cached per language; limited to 20 a minute per tenant; audited.', roles: PAYLOAD, q: { language: 'English, Spanish, French, German, Portuguese, Italian, Dutch, Chinese, Japanese, Korean, Hindi or Arabic', refresh: '1 to regenerate' } },
  { m: 'get', p: '/tenants/{tenantId}/recipes', tag: 'Recipes', s: 'Workato recipes seen, with their direction and document type', roles: MEMBER },
  { m: 'put', p: '/tenants/{tenantId}/recipes/{recipeId}', tag: 'Recipes', s: 'Override a recipe\'s direction, document type or whether its jobs are kept', d: 'ingest_mode: auto (decide from the job), include (always keep, e.g. a stage recipe between an ERP and Orderful) or ignore. Changing direction or document type re-normalizes the recipe\'s events.', roles: 'platform admin, customer admin', body: { direction: 'inbound', document_type: '850', ingest_mode: 'include' } },

  // ---------------------------------------------------------------- partners and flows
  { m: 'get', p: '/tenants/{tenantId}/partners', tag: 'Partners & flows', s: 'Trading partners seen in traffic', roles: MEMBER },
  { m: 'put', p: '/tenants/{tenantId}/partners/{partnerId}/settings', tag: 'Partners & flows', s: '997 tracking switches for a partner', roles: CONFIG, body: { trackInboundAck: true, expectOutboundAck: false } },
  { m: 'get', p: '/tenants/{tenantId}/partners/{partnerId}/flows', tag: 'Partners & flows', s: 'A partner\'s document flows', roles: MEMBER },
  { m: 'post', p: '/tenants/{tenantId}/partners/{partnerId}/flows', tag: 'Partners & flows', s: 'Create a flow', roles: CONFIG, ok: 201, body: { name: 'Order to cash', steps: [{ docType: '850', direction: 'inbound' }, { docType: '856', direction: 'outbound', slaMinutes: 240 }] } },
  { m: 'put', p: '/tenants/{tenantId}/partners/{partnerId}/flows/{flowId}', tag: 'Partners & flows', s: 'Change a flow', roles: CONFIG, body: { name: 'Order to cash', steps: [{ docType: '850', direction: 'inbound' }] } },
  { m: 'delete', p: '/tenants/{tenantId}/partners/{partnerId}/flows/{flowId}', tag: 'Partners & flows', s: 'Delete a flow', roles: CONFIG, ok: 204 },
  { m: 'post', p: '/tenants/{tenantId}/partners/track', tag: 'Partners & flows', s: 'Track a business document along a partner\'s flow', roles: MEMBER, body: { partnerId: 'ISAID', identifierType: 'po', value: 'PO-123' } },

  // ---------------------------------------------------------------- alerts
  { m: 'get', p: '/tenants/{tenantId}/actions/ticketing', tag: 'Tickets & reports', s: 'Which ticket system the tenant uses, if any', roles: 'any member except auditors' },
  { m: 'post', p: '/tenants/{tenantId}/actions/tickets', tag: 'Tickets & reports', s: 'Raise a Jira or ServiceNow ticket for one or more documents', d: 'Needs a reason and a priority; the rest (partners, status, failure, Orderful and Workato identifiers, business facts, links) is filled in from the document. Never includes raw EDI. Up to 25 documents per ticket; 30 tickets an hour per user.', roles: 'platform admin, customer admin, support, business', ok: 201, body: { transactionIds: [150], reason: 'Partner says the 855 never arrived', priority: 'high', summary: 'optional title' } },
  { m: 'get', p: '/tenants/{tenantId}/actions/transactions/{id}/tickets', tag: 'Tickets & reports', s: 'Tickets already raised for a document', roles: 'platform admin, customer admin, support, business' },
  { m: 'get', p: '/tenants/{tenantId}/actions/tickets', tag: 'Tickets & reports', s: 'Tickets raised from the portal', d: 'With the latest status copied from Jira or ServiceNow and the documents each covers.', roles: 'platform admin, customer admin, support, business', q: { state: 'open to hide finished tickets' } },
  { m: 'get', p: '/tenants/{tenantId}/actions/tickets/{id}', tag: 'Tickets & reports', s: 'One ticket with its comments', d: 'refresh=1 reads the ticket system first.', roles: 'platform admin, customer admin, support, business', q: { refresh: '1 to read the ticket system first' } },
  { m: 'post', p: '/tenants/{tenantId}/actions/tickets/{id}/refresh', tag: 'Tickets & reports', s: 'Re-read a ticket from Jira or ServiceNow', roles: 'platform admin, customer admin, support, business' },
  { m: 'post', p: '/tenants/{tenantId}/actions/tickets/{id}/comments', tag: 'Tickets & reports', s: 'Comment on a ticket', d: 'Written to the ticket system under the service account, signed with the portal user.', roles: 'platform admin, customer admin, support, business', ok: 201, body: { body: 'We resent the 855.' } },
  { m: 'get', p: '/tenants/{tenantId}/actions/tickets/{id}/transitions', tag: 'Tickets & reports', s: 'Status changes the ticket system allows now', d: 'Jira only; ServiceNow status is changed in ServiceNow.', roles: 'platform admin, customer admin, support, business' },
  { m: 'post', p: '/tenants/{tenantId}/actions/tickets/{id}/transition', tag: 'Tickets & reports', s: 'Change a Jira ticket status', roles: 'platform admin, customer admin, support, business', body: { transitionId: '31' } },
  { m: 'post', p: '/tenants/{tenantId}/actions/reports/email', tag: 'Tickets & reports', s: 'Email a report on one or more documents to someone', d: 'Sends a business-and-technical HTML report through the tenant’s Brevo account to up to 5 addresses (one message each), with a reply-to of the sender. 20 reports an hour per user; audited. Never includes raw EDI.', roles: 'platform admin, customer admin, support, business', body: { transactionIds: [150], to: ['colleague@example.com'], subject: 'EDI 855 failed validation', note: 'Can you check this one?' } },
  { m: 'get', p: '/tenants/{tenantId}/alerts', tag: 'Email alerts', s: 'My alert subscriptions and whether email is set up', roles: MEMBER },
  { m: 'post', p: '/tenants/{tenantId}/alerts', tag: 'Email alerts', s: 'Subscribe to alerts', d: 'Goes to the caller\'s own address.', roles: MEMBER, ok: 201, body: { partnerId: 'ISAID', documentType: '850', trigger: 'failure' } },
  { m: 'patch', p: '/tenants/{tenantId}/alerts/{id}', tag: 'Email alerts', s: 'Turn an alert on or off, or change its trigger', roles: 'the owner of the alert', body: { isActive: false, trigger: 'both' } },
  { m: 'delete', p: '/tenants/{tenantId}/alerts/{id}', tag: 'Email alerts', s: 'Delete an alert', roles: 'the owner of the alert', ok: 204 },
  { m: 'post', p: '/tenants/{tenantId}/alerts/test', tag: 'Email alerts', s: 'Send myself a test email', d: 'Always to the caller\'s own address; rate limited. Sends a real email through the tenant\'s Brevo account.', roles: MEMBER },
  { m: 'get', p: '/tenants/{tenantId}/ack-rules', tag: '997 reminder rules', s: 'List 997 reminder rules', roles: CONFIG },
  { m: 'post', p: '/tenants/{tenantId}/ack-rules', tag: '997 reminder rules', s: 'Create a rule', d: 'Email these people when a partner 997 has been pending more than N hours, at these times of day in the tenant time zone.', roles: 'platform admin, customer admin', ok: 201, body: { name: 'Walmart 997 overdue', partnerId: 'ISAID', documentTypes: ['855'], direction: 'both', thresholdHours: 24, recipients: ['ops@example.com'], sendTimes: ['08:00', '17:00'] } },
  { m: 'put', p: '/tenants/{tenantId}/ack-rules/{id}', tag: '997 reminder rules', s: 'Change a rule', roles: 'platform admin, customer admin', body: { name: 'Walmart 997 overdue', thresholdHours: 24, recipients: ['ops@example.com'], sendTimes: ['08:00'] } },
  { m: 'patch', p: '/tenants/{tenantId}/ack-rules/{id}', tag: '997 reminder rules', s: 'Turn a rule on or off', roles: 'platform admin, customer admin', body: { isActive: false } },
  { m: 'delete', p: '/tenants/{tenantId}/ack-rules/{id}', tag: '997 reminder rules', s: 'Delete a rule', roles: 'platform admin, customer admin', ok: 204 },
  { m: 'get', p: '/tenants/{tenantId}/ack-rules/{id}/preview', tag: '997 reminder rules', s: 'What the rule would report now', d: 'Sends nothing.', roles: CONFIG },
  { m: 'get', p: '/tenants/{tenantId}/ack-rules/{id}/runs', tag: '997 reminder rules', s: 'Last 10 runs of a rule', roles: CONFIG },
  { m: 'post', p: '/tenants/{tenantId}/ack-rules/{id}/run', tag: '997 reminder rules', s: 'Run a rule now', d: 'Re-checks Orderful, then sends a real email to the recipients if anything is waiting. Rate limited.', roles: 'platform admin, customer admin' },

  // ---------------------------------------------------------------- generator
  { m: 'get', p: '/tenants/{tenantId}/generator/doc-types', tag: 'Test EDI generator', s: 'Document types and their form definitions', roles: CONFIG },
  { m: 'get', p: '/tenants/{tenantId}/generator/presets', tag: 'Test EDI generator', s: 'Starter trading-partner profiles', roles: CONFIG },
  { m: 'get', p: '/tenants/{tenantId}/generator/traffic-partners', tag: 'Test EDI generator', s: 'Real trading partners from the tenant\'s traffic, with profiles read from their latest EDI envelope', roles: CONFIG },
  { m: 'get', p: '/tenants/{tenantId}/generator/partners', tag: 'Test EDI generator', s: 'Saved test trading partners', roles: CONFIG },
  { m: 'post', p: '/tenants/{tenantId}/generator/partners', tag: 'Test EDI generator', s: 'Save a test trading partner', roles: CONFIG, ok: 201, body: { partner: { name: 'Acme', code: 'ACME' } } },
  { m: 'put', p: '/tenants/{tenantId}/generator/partners/{id}', tag: 'Test EDI generator', s: 'Change a test trading partner', roles: CONFIG, body: { partner: { name: 'Acme', code: 'ACME' }, isaControlNext: 1 } },
  { m: 'delete', p: '/tenants/{tenantId}/generator/partners/{id}', tag: 'Test EDI generator', s: 'Delete a test trading partner (history is kept)', roles: CONFIG, ok: 204 },
  { m: 'post', p: '/tenants/{tenantId}/generator/defaults', tag: 'Test EDI generator', s: 'Default form values for a document and partner', roles: CONFIG, body: { docType: '850', partnerId: 1 } },
  { m: 'post', p: '/tenants/{tenantId}/generator/preview', tag: 'Test EDI generator', s: 'Build a file without taking control numbers', roles: CONFIG, body: { docType: '850', partnerId: 1 } },
  { m: 'post', p: '/tenants/{tenantId}/generator/generate', tag: 'Test EDI generator', s: 'Build a file, take the partner\'s next control numbers and record it', roles: CONFIG, ok: 201, body: { docType: '850', partnerId: 1 } },
  { m: 'get', p: '/tenants/{tenantId}/generator/history', tag: 'Test EDI generator', s: 'Files generated so far (without content)', roles: CONFIG },
  { m: 'get', p: '/tenants/{tenantId}/generator/history/{id}/download', tag: 'Test EDI generator', s: 'Download a generated file again', roles: CONFIG, file: 'application/edi-x12' },

  // ---------------------------------------------------------------- admin
  { m: 'get', p: '/admin/tenants', tag: 'Admin: tenants', s: 'All tenants', roles: ADMIN },
  { m: 'post', p: '/admin/tenants', tag: 'Admin: tenants', s: 'Create a tenant', d: 'Provisions its queues.', roles: ADMIN, ok: 201, body: { name: 'Nordic Naturals', slug: 'nordic_naturals', timezone: 'America/Los_Angeles', source_mode: 'push', workato_account_id: '12345' } },
  { m: 'get', p: '/admin/tenants/{tenantId}', tag: 'Admin: tenants', s: 'One tenant with credentials (hints only), API keys and queue depth', roles: 'platform admin, or the tenant\'s own customer admin' },
  { m: 'patch', p: '/admin/tenants/{tenantId}', tag: 'Admin: tenants', s: 'Change tenant settings', roles: ADMIN, body: { name: 'string', timezone: 'string', raw_edi_enabled: true } },
  { m: 'post', p: '/admin/tenants/{tenantId}/readiness', tag: 'Admin: tenants', s: 'Run the go-live readiness checks', roles: ADMIN },
  { m: 'post', p: '/admin/tenants/{tenantId}/status', tag: 'Admin: tenants', s: 'Move the tenant through its lifecycle', d: 'draft → validation_pending → active ⇄ suspended → offboarded. Activating needs a passing readiness check.', roles: ADMIN, body: { status: 'active' } },
  { m: 'put', p: '/admin/tenants/{tenantId}/credentials/{kind}', tag: 'Admin: credentials', s: 'Save a secret (orderful, workato, gemini or brevo)', d: 'Encrypted at rest and only ever shown as its last four characters. Brevo also takes extra.senderEmail.', roles: 'platform admin, or the tenant\'s own customer admin', body: { secret: 'string', environment: 'production', extra: { senderEmail: 'alerts@example.com' } } },
  { m: 'post', p: '/admin/tenants/{tenantId}/api-keys', tag: 'Admin: credentials', s: 'Create an ingest API key', d: 'The key is shown once.', roles: 'platform admin, or the tenant\'s own customer admin', ok: 201, body: { name: 'Workato production' } },
  { m: 'delete', p: '/admin/tenants/{tenantId}/api-keys/{keyId}', tag: 'Admin: credentials', s: 'Revoke an API key', roles: 'platform admin, or the tenant\'s own customer admin', ok: 204 },
  { m: 'get', p: '/admin/tenants/{tenantId}/ticketing', tag: 'Admin: credentials', s: 'The saved ticket-system connection (no secret)', roles: 'platform admin, or the tenant’s own customer admin' },
  { m: 'put', p: '/admin/tenants/{tenantId}/ticketing', tag: 'Admin: credentials', s: 'Connect Jira or ServiceNow for ticket creation', d: 'The address must be https and on the public internet. The API token or password is encrypted and optional on later saves. provider null turns tickets off.', roles: 'platform admin, or the tenant’s own customer admin', body: { provider: 'jira', baseUrl: 'https://yourco.atlassian.net', email: 'svc@yourco.com', secret: 'api token', projectKey: 'OPS', issueType: 'Task' } },
  { m: 'get', p: '/tenants/{tenantId}/chat/status', tag: 'Assistant', s: 'Is the assistant available', d: 'Whether it is switched on, whether a Gemini key is saved, and today usage against the daily limit.', roles: MEMBER },
  { m: 'post', p: '/tenants/{tenantId}/chat', tag: 'Assistant', s: 'Ask the assistant', d: 'Send the conversation so far (the last message is the question). Returns the reply and any confirmation cards. Cards are only prepared, never executed; Confirm calls the normal endpoints. Uses the tenant Gemini key; limited per user and per tenant per day.', roles: MEMBER, body: { messages: [{ role: 'user', text: 'Did we receive PO 100 from Acme?' }] } },
  { m: 'get', p: '/admin/tenants/{tenantId}/assistant', tag: 'Admin: credentials', s: 'Assistant switch and daily limit', roles: 'platform admin, or the tenant customer admin' },
  { m: 'put', p: '/admin/tenants/{tenantId}/assistant', tag: 'Admin: credentials', s: 'Switch the assistant on or off and set its daily limit', roles: 'platform admin, or the tenant customer admin', body: { enabled: true, dailyLimit: 300 } },
  { m: 'post', p: '/mcp', tag: 'MCP server', s: 'MCP endpoint (read-only tools)', d: 'JSON-RPC 2.0 over HTTP: initialize, tools/list, tools/call. Authenticated with an MCP key (Authorization: Bearer ... or x-api-key); ingestion keys are refused. Offers find_documents, get_document, pending_997, list_partners, list_tickets, list_997_rules for the key tenant only.', auth: 'apiKey', roles: 'an MCP key', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
  { m: 'get', p: '/platform/activity', tag: 'Platform', s: 'Ingest, MCP and assistant activity', d: 'Calls and errors in the last 24 hours per channel and tenant, recent errors, and the public endpoint addresses.', roles: ADMIN },
  { m: 'get', p: '/admin/tenants/{tenantId}/ticketing/sync', tag: 'Admin: credentials', s: 'Ticket sync status', d: 'Tickets tracked, open, finished and failing to read; last and next read; recent errors.', roles: 'platform admin, or the tenant customer admin' },
  { m: 'post', p: '/admin/tenants/{tenantId}/ticketing/sync', tag: 'Admin: credentials', s: 'Sync tickets now', d: 'Reads up to 30 unfinished tickets from Jira or ServiceNow immediately.', roles: 'platform admin, or the tenant customer admin' },
  { m: 'post', p: '/admin/tenants/{tenantId}/ticketing/test', tag: 'Admin: credentials', s: 'Test the ticket-system connection without creating anything', roles: 'platform admin, or the tenant’s own customer admin' },
  { m: 'get', p: '/admin/tenants/{tenantId}/quarantine', tag: 'Admin: tenants', s: 'Events refused at ingestion', roles: 'platform admin, or the tenant\'s own customer admin' },
  { m: 'get', p: '/admin/tenants/{tenantId}/members', tag: 'Admin: members', s: 'Members and pending invitations', roles: 'platform admin, customer admin' },
  { m: 'post', p: '/admin/tenants/{tenantId}/members', tag: 'Admin: members', s: 'Add a member and invite them', roles: 'platform admin, customer admin', ok: 201, body: { email: 'user@example.com', role: 'business', firstName: 'Ada', lastName: 'Lovelace' } },
  { m: 'patch', p: '/admin/tenants/{tenantId}/members/{userId}', tag: 'Admin: members', s: 'Change a member\'s role, name or active state', roles: 'platform admin, customer admin', body: { role: 'support', isActive: true } },
  { m: 'post', p: '/admin/tenants/{tenantId}/members/{userId}/invite', tag: 'Admin: members', s: 'Send a new invitation link', roles: 'platform admin, customer admin' },

  // ---------------------------------------------------------------- platform
  { m: 'get', p: '/platform/health', tag: 'Platform', s: 'Detailed platform health', d: 'Database, broker, migrations, tenant consumers, background workers and queue backlogs. Read-only; reveals no secrets.', roles: ADMIN },
  { m: 'get', p: '/platform/openapi.json', tag: 'Platform', s: 'This API description (OpenAPI 3)', roles: ADMIN },
];

const schemaOf = (v: unknown): any => {
  if (Array.isArray(v)) return { type: 'array', items: v.length ? schemaOf(v[0]) : {} };
  if (v && typeof v === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, schemaOf(x)])) };
  return { type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string' };
};

const REASONS: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No content', 400: 'Invalid request', 401: 'Not signed in', 403: 'Not allowed', 404: 'Not found', 409: 'Conflict', 429: 'Too many requests' };

export function buildOpenApi(): any {
  const paths: Record<string, any> = {};
  for (const e of ENDPOINTS) {
    const auth: Auth = e.auth ?? 'bearer';
    const params: any[] = [...e.p.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    for (const [name, description] of Object.entries(e.q ?? {})) params.push({ name, in: 'query', required: false, description, schema: { type: 'string' } });

    const ok = e.ok ?? 200;
    const responses: Record<string, any> = {
      [ok]: ok === 204 ? { description: REASONS[204] } : e.file ? { description: 'File', content: { [e.file]: { schema: { type: 'string', format: 'binary' } } } } : { description: REASONS[ok], content: { 'application/json': { schema: { type: 'object' } } } },
    };
    if (e.body) responses['400'] = { description: REASONS[400] };
    if (auth !== 'none') {
      responses['401'] = { description: REASONS[401] };
      if (e.roles) responses['403'] = { description: REASONS[403] };
    }
    if (e.p.includes('{')) responses['404'] = { description: REASONS[404] };

    const op: any = {
      tags: [e.tag],
      summary: e.s,
      description: [e.d, e.roles ? `**Who:** ${e.roles}` : null].filter(Boolean).join('\n\n') || undefined,
      parameters: params.length ? params : undefined,
      responses,
      security: auth === 'none' ? [] : auth === 'apiKey' ? [{ apiKeyAuth: [] }] : [{ bearerAuth: [] }],
    };
    if (e.body) op.requestBody = { required: true, content: { 'application/json': { schema: schemaOf(e.body), example: e.body } } };
    (paths[e.p] ??= {})[e.m] = op;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'EDI360 API',
      version: '1.0.0',
      description: 'Orderful → Workato → ERP visibility. Sign in with POST /auth/login, then use Authorize with the returned token (the portal pre-fills it for you). Ingest uses a tenant API key instead.',
    },
    servers: [{ url: '/api' }],
    tags: [...new Set(ENDPOINTS.map((e) => e.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      },
    },
  };
}
