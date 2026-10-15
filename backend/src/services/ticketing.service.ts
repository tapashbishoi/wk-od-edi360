import { env } from '../config/env.js';
import { queryOne } from '../db/connection.js';
import { decryptSecret } from '../utils/crypto.js';
import { assertSafeHttpsUrl, UnsafeUrlError } from '../utils/urlGuard.js';
import { logger } from '../utils/logger.js';

/**
 * Raises a ticket in the tenant's own Jira or ServiceNow, with the connection details its admin saved on
 * the tenant page. The API token or password is encrypted at rest and never leaves this module; error
 * text carries what the ticket system said, never the credentials or the ticket body.
 *
 * The address is typed in by the admin, so it is checked before every call (https, public addresses only)
 * and redirects are refused, so it cannot be turned into a way to reach internal services.
 */

export type Provider = 'jira' | 'servicenow';
export type Priority = 'critical' | 'high' | 'medium' | 'low';
export const PRIORITIES: Priority[] = ['critical', 'high', 'medium', 'low'];

const TIMEOUT_MS = 20_000;

export interface JiraConfig {
  provider: 'jira';
  baseUrl: string;
  email: string;
  projectKey: string;
  issueType: string;
  /** Names of the project's priorities, by our four levels; Jira schemes differ */
  priorityNames: Record<Priority, string>;
}
export interface ServiceNowConfig {
  provider: 'servicenow';
  baseUrl: string;
  username: string;
  category?: string;
  /** sys_id of the group the incident is assigned to */
  assignmentGroup?: string;
}
export type TicketConfig = (JiraConfig | ServiceNowConfig) & { secret: string };

export class TicketError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

export const DEFAULT_PRIORITY_NAMES: Record<Priority, string> = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' };

// ---- validating what an admin saves

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Cleans and checks connection details from the admin form. Throws TicketError (400) with the reason. */
export async function normalizeConfig(provider: unknown, input: Record<string, unknown>): Promise<Omit<JiraConfig, 'provider'> & { provider: 'jira' } | Omit<ServiceNowConfig, 'provider'> & { provider: 'servicenow' }> {
  const bad = (m: string) => new TicketError(m, 400);
  const checkUrl = async (raw: string, what: string) => {
    if (!raw) throw bad(`${what} is required`);
    try {
      const u = await assertSafeHttpsUrl(raw, env.TICKETING_ALLOW_PRIVATE);
      return u.origin; // path and query dropped: only the site address is kept
    } catch (e) {
      throw bad(e instanceof UnsafeUrlError ? `${what}: ${e.message}` : `${what} is not valid`);
    }
  };

  if (provider === 'jira') {
    const baseUrl = await checkUrl(str(input.baseUrl, 200), 'Jira address');
    const email = str(input.email, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('The Jira account email is required');
    const projectKey = str(input.projectKey, 20).toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(projectKey)) throw bad('The Jira project key looks like OPS or EDI');
    const issueType = str(input.issueType, 60) || 'Task';
    const given = (input.priorityNames && typeof input.priorityNames === 'object' ? input.priorityNames : {}) as Record<string, unknown>;
    const priorityNames = Object.fromEntries(PRIORITIES.map((p) => [p, str(given[p], 40) || DEFAULT_PRIORITY_NAMES[p]])) as Record<Priority, string>;
    return { provider: 'jira', baseUrl, email, projectKey, issueType, priorityNames };
  }
  if (provider === 'servicenow') {
    const baseUrl = await checkUrl(str(input.baseUrl, 200), 'ServiceNow address');
    const username = str(input.username, 100);
    if (!username) throw bad('The ServiceNow user name is required');
    const assignmentGroup = str(input.assignmentGroup, 64);
    if (assignmentGroup && !/^[0-9a-fA-F]{32}$/.test(assignmentGroup)) throw bad('The assignment group is its 32-character sys_id');
    const category = str(input.category, 60);
    return { provider: 'servicenow', baseUrl, username, ...(category ? { category } : {}), ...(assignmentGroup ? { assignmentGroup } : {}) };
  }
  throw bad('Choose Jira or ServiceNow');
}

/** The tenant's active ticket system with its decrypted secret, or null if none is set up. */
export async function loadTicketConfig(tenantId: number): Promise<TicketConfig | null> {
  const t = await queryOne<{ ticket_provider: Provider | null }>(`SELECT ticket_provider FROM wk_tenants WHERE id = $1`, [tenantId]);
  if (!t?.ticket_provider) return null;
  const c = await queryOne<{ secret_enc: string; extra: Record<string, any> }>(
    `SELECT secret_enc, extra FROM wk_tenant_credentials WHERE tenant_id = $1 AND kind = $2 LIMIT 1`,
    [tenantId, t.ticket_provider]
  );
  if (!c) return null;
  try {
    return { ...(c.extra as any), provider: t.ticket_provider, secret: decryptSecret(c.secret_enc) } as TicketConfig;
  } catch {
    return null; // saved under an old encryption key: the admin has to re-enter it
  }
}

// ---- calling the ticket system

async function call(cfg: TicketConfig, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<{ status: number; json: any }> {
  let url: URL;
  try {
    url = await assertSafeHttpsUrl(cfg.baseUrl + path, env.TICKETING_ALLOW_PRIVATE);
  } catch (e) {
    throw new TicketError(`The ticket system address cannot be used: ${(e as Error).message}`, 400);
  }
  const user = cfg.provider === 'jira' ? cfg.email : cfg.username;
  try {
    const res = await fetch(url, {
      method,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Basic ${Buffer.from(`${user}:${cfg.secret}`).toString('base64')}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, json };
  } catch (error: any) {
    const why = error?.name === 'TimeoutError' ? 'timed out' : /redirect/i.test(String(error?.message)) ? 'it redirected, which is not followed' : 'could not be reached';
    logger.warn(`[Ticketing] ${cfg.provider} call failed: ${why}`);
    throw new TicketError(`The ticket system ${why}`);
  }
}

function describeError(provider: Provider, status: number, json: any): string {
  if (status === 401 || status === 403) return `${provider === 'jira' ? 'Jira' : 'ServiceNow'} refused the credentials (${status}). Check the user and token on the tenant page.`;
  if (status === 404) return `${provider === 'jira' ? 'Jira' : 'ServiceNow'} did not find that address or project (404).`;
  const detail =
    provider === 'jira'
      ? [...(json?.errorMessages ?? []), ...Object.values(json?.errors ?? {})].filter((x) => typeof x === 'string').join('; ')
      : json?.error?.message;
  return `${provider === 'jira' ? 'Jira' : 'ServiceNow'} rejected the ticket (${status})${detail ? `: ${String(detail).slice(0, 250)}` : ''}`;
}

/** Cheap read that proves the address and credentials work, without creating anything. */
export async function testConnection(cfg: TicketConfig): Promise<{ ok: boolean; detail: string }> {
  const r = cfg.provider === 'jira' ? await call(cfg, 'GET', '/rest/api/2/myself') : await call(cfg, 'GET', '/api/now/table/incident?sysparm_limit=1&sysparm_fields=number');
  if (r.status >= 200 && r.status < 300) {
    return { ok: true, detail: cfg.provider === 'jira' ? `Connected as ${r.json?.displayName ?? cfg.email}` : `Connected as ${cfg.username}` };
  }
  return { ok: false, detail: describeError(cfg.provider, r.status, r.json) };
}

export interface NewTicket {
  summary: string;
  /** Plain text; Jira renders it as is, which is readable */
  description: string;
  priority: Priority;
}

export interface CreatedTicket {
  key: string;
  url: string;
  /** ServiceNow sys_id; Jira is addressed by key */
  ref?: string;
}

export async function createTicket(cfg: TicketConfig, t: NewTicket): Promise<CreatedTicket> {
  if (cfg.provider === 'jira') {
    const fields: Record<string, unknown> = {
      project: { key: cfg.projectKey },
      summary: t.summary.slice(0, 250),
      issuetype: { name: cfg.issueType },
      description: t.description,
      labels: ['edi-portal'],
    };
    let r = await call(cfg, 'POST', '/rest/api/2/issue', { fields: { ...fields, priority: { name: cfg.priorityNames[t.priority] } } });
    // A project whose priority scheme lacks that name: still raise the ticket, with the priority in the text
    if (r.status === 400 && r.json?.errors?.priority) {
      r = await call(cfg, 'POST', '/rest/api/2/issue', { fields: { ...fields, description: `Priority: ${t.priority.toUpperCase()}\n\n${t.description}` } });
    }
    if (r.status !== 201 || !r.json?.key) throw new TicketError(describeError('jira', r.status, r.json));
    return { key: String(r.json.key), url: `${cfg.baseUrl}/browse/${encodeURIComponent(r.json.key)}` };
  }

  // ServiceNow derives priority from impact and urgency (1 high, 2 medium, 3 low)
  const levels: Record<Priority, [string, string]> = { critical: ['1', '1'], high: ['2', '1'], medium: ['2', '2'], low: ['3', '3'] };
  const [impact, urgency] = levels[t.priority];
  const r = await call(cfg, 'POST', '/api/now/table/incident', {
    short_description: t.summary.slice(0, 160),
    description: t.description,
    impact, urgency,
    ...(cfg.category ? { category: cfg.category } : {}),
    ...(cfg.assignmentGroup ? { assignment_group: cfg.assignmentGroup } : {}),
  });
  const result = r.json?.result;
  if (r.status !== 201 || !result?.number) throw new TicketError(describeError('servicenow', r.status, r.json));
  return { key: String(result.number), url: `${cfg.baseUrl}/nav_to.do?uri=${encodeURIComponent(`incident.do?sys_id=${result.sys_id}`)}`, ref: String(result.sys_id) };
}

// ---- following a ticket after it was raised

export type StatusCategory = 'open' | 'in_progress' | 'done';

/** What identifies a ticket in its own system */
export interface TicketRef {
  key: string;
  /** ServiceNow sys_id */
  ref: string | null;
}

export interface RemoteComment {
  id: string;
  author: string | null;
  body: string;
  createdAt: string;
}

export interface RemoteTicket {
  status: string;
  category: StatusCategory;
  assignee: string | null;
  priority: string | null;
  updatedAt: string | null;
  comments: RemoteComment[];
}

export interface Transition {
  id: string;
  name: string;
  to: string;
  category: StatusCategory;
}

/** Where the portal marks a comment it posted, since it is written under the one service account. */
export const PORTAL_COMMENT_MARK = 'Posted from EDI Portal by';

const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const SYS_ID = /^[0-9a-fA-F]{32}$/;

const jiraCategory = (key: unknown): StatusCategory => (key === 'done' ? 'done' : key === 'indeterminate' ? 'in_progress' : 'open');
/** ServiceNow incident states: 6 Resolved, 7 Closed, 8 Canceled are finished; 2 In Progress and 3 On Hold are under way. */
const snCategory = (state: unknown): StatusCategory => (['6', '7', '8'].includes(String(state)) ? 'done' : ['2', '3'].includes(String(state)) ? 'in_progress' : 'open');
const snTime = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? new Date(`${s.replace(' ', 'T')}Z`).toISOString() : null);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

function checkRef(cfg: TicketConfig, t: TicketRef): string {
  if (cfg.provider === 'jira') {
    if (!JIRA_KEY.test(t.key)) throw new TicketError('That ticket key is not valid', 400);
    return encodeURIComponent(t.key);
  }
  if (!t.ref || !SYS_ID.test(t.ref)) throw new TicketError('This ServiceNow ticket has no record id, so it cannot be followed from here.', 400);
  return t.ref;
}

function describeRead(cfg: TicketConfig, status: number, json: any): string {
  const name = cfg.provider === 'jira' ? 'Jira' : 'ServiceNow';
  if (status === 404) return `${name} no longer has this ticket, or the service account cannot see it (404).`;
  if (status === 401 || status === 403) return `${name} refused the credentials (${status}). Check the user and token on the tenant page.`;
  return describeError(cfg.provider, status, json).replace('rejected the ticket', 'refused the request');
}

/** The ticket as it stands in its own system: status, assignee, priority and comments. */
export async function fetchRemote(cfg: TicketConfig, t: TicketRef): Promise<RemoteTicket> {
  const id = checkRef(cfg, t);
  if (cfg.provider === 'jira') {
    const r = await call(cfg, 'GET', `/rest/api/2/issue/${id}?fields=status,assignee,priority,updated,comment`);
    if (r.status !== 200 || !r.json?.fields) throw new TicketError(describeRead(cfg, r.status, r.json));
    const f = r.json.fields;
    const comments: RemoteComment[] = (f.comment?.comments ?? []).slice(-50).map((c: any) => ({
      id: String(c.id), author: text(c.author?.displayName, 120) || null, body: text(c.body, 8000), createdAt: new Date(c.created).toISOString(),
    }));
    return {
      status: text(f.status?.name, 80) || 'Unknown', category: jiraCategory(f.status?.statusCategory?.key),
      assignee: text(f.assignee?.displayName, 120) || null, priority: text(f.priority?.name, 40) || null,
      updatedAt: f.updated ? new Date(f.updated).toISOString() : null, comments,
    };
  }

  const r = await call(cfg, 'GET', `/api/now/table/incident/${id}?sysparm_display_value=all&sysparm_fields=state,priority,assigned_to,sys_updated_on`);
  const row = r.json?.result;
  if (r.status !== 200 || !row) throw new TicketError(describeRead(cfg, r.status, r.json));
  // Customer-visible comments only; work notes are internal. If the account cannot read journals, the ticket still syncs.
  let comments: RemoteComment[] = [];
  try {
    const j = await call(cfg, 'GET', `/api/now/table/sys_journal_field?sysparm_query=${encodeURIComponent(`element_id=${id}^element=comments^ORDERBYsys_created_on`)}&sysparm_fields=sys_id,value,sys_created_by,sys_created_on&sysparm_limit=50`);
    if (j.status === 200) {
      comments = (j.json?.result ?? []).map((c: any) => ({ id: String(c.sys_id), author: text(c.sys_created_by, 120) || null, body: text(c.value, 8000), createdAt: snTime(c.sys_created_on) ?? new Date().toISOString() }));
    }
  } catch {
    /* not readable */
  }
  return {
    status: text(row.state?.display_value, 80) || 'Unknown', category: snCategory(row.state?.value),
    assignee: text(row.assigned_to?.display_value, 120) || null, priority: text(row.priority?.display_value, 40) || null,
    updatedAt: snTime(row.sys_updated_on?.value ?? row.sys_updated_on), comments,
  };
}

/** Adds a comment. Jira returns its id; ServiceNow does not, so the next read brings it in. */
export async function addComment(cfg: TicketConfig, t: TicketRef, body: string): Promise<{ id: string | null }> {
  const id = checkRef(cfg, t);
  if (cfg.provider === 'jira') {
    const r = await call(cfg, 'POST', `/rest/api/2/issue/${id}/comment`, { body });
    if (r.status !== 201) throw new TicketError(describeRead(cfg, r.status, r.json));
    return { id: r.json?.id ? String(r.json.id) : null };
  }
  const r = await call(cfg, 'PATCH', `/api/now/table/incident/${id}`, { comments: body });
  if (r.status !== 200) throw new TicketError(describeRead(cfg, r.status, r.json));
  return { id: null };
}

/** The moves Jira allows from the ticket's current status (they depend on its workflow). */
export async function listTransitions(cfg: TicketConfig, t: TicketRef): Promise<Transition[]> {
  if (cfg.provider !== 'jira') return [];
  const r = await call(cfg, 'GET', `/rest/api/2/issue/${checkRef(cfg, t)}/transitions`);
  if (r.status !== 200) throw new TicketError(describeRead(cfg, r.status, r.json));
  return (r.json?.transitions ?? []).map((x: any) => ({ id: String(x.id), name: text(x.name, 80), to: text(x.to?.name, 80), category: jiraCategory(x.to?.statusCategory?.key) }));
}

export async function transitionTicket(cfg: TicketConfig, t: TicketRef, transitionId: string): Promise<void> {
  if (cfg.provider !== 'jira') throw new TicketError('Change the status in ServiceNow; the portal shows it once it changes.', 400);
  if (!/^\d{1,6}$/.test(transitionId)) throw new TicketError('Invalid status change', 400);
  const r = await call(cfg, 'POST', `/rest/api/2/issue/${checkRef(cfg, t)}/transitions`, { transition: { id: transitionId } });
  if (r.status !== 204) throw new TicketError(describeRead(cfg, r.status, r.json), r.status === 400 ? 400 : 502);
}
