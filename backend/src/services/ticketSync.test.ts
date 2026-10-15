import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/connection.js', () => ({ query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn() }));
vi.mock('../utils/urlGuard.js', () => ({ assertSafeHttpsUrl: async (u: string) => new URL(u), UnsafeUrlError: class extends Error {} }));

const { fetchRemote, addComment, listTransitions, transitionTicket } = await import('./ticketing.service.js');
const { nextSyncMinutes } = await import('./ticketSync.service.js');

const jira: any = { provider: 'jira', baseUrl: 'https://co.atlassian.net', email: 'svc@co.com', projectKey: 'OPS', issueType: 'Task', priorityNames: {}, secret: 's3cret' };
const snow: any = { provider: 'servicenow', baseUrl: 'https://co.service-now.com', username: 'svc', secret: 'pw' };
const reply = (status: number, json?: unknown) => ({ status, json: async () => { if (json === undefined) throw new Error('no body'); return json; } });

describe('following a Jira ticket', () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  beforeEach(() => { calls.length = 0; });
  afterEach(() => { vi.unstubAllGlobals(); });
  const fake = (answers: Record<string, any>) => vi.stubGlobal('fetch', async (url: URL, init: any) => {
    calls.push({ url: url.toString(), method: init.method, body: init.body });
    const hit = Object.entries(answers).find(([k]) => `${init.method} ${url.pathname}` === k);
    return hit ? hit[1] : reply(404, {});
  });

  it('reads status, category, assignee, priority and comments', async () => {
    fake({ 'GET /rest/api/2/issue/OPS-7': reply(200, { fields: {
      status: { name: 'In Review', statusCategory: { key: 'indeterminate' } }, assignee: { displayName: 'Dana' }, priority: { name: 'High' }, updated: '2026-10-13T10:00:00.000+0000',
      comment: { comments: [{ id: '10', author: { displayName: 'Dana' }, body: 'Looking', created: '2026-10-13T09:00:00.000+0000' }] },
    } }) });
    const r = await fetchRemote(jira, { key: 'OPS-7', ref: null });
    expect(r).toMatchObject({ status: 'In Review', category: 'in_progress', assignee: 'Dana', priority: 'High' });
    expect(r.comments).toEqual([{ id: '10', author: 'Dana', body: 'Looking', createdAt: '2026-10-13T09:00:00.000Z' }]);
  });

  it('maps a done status category and an unassigned ticket', async () => {
    fake({ 'GET /rest/api/2/issue/OPS-7': reply(200, { fields: { status: { name: 'Done', statusCategory: { key: 'done' } }, assignee: null, priority: null, comment: { comments: [] } } }) });
    expect(await fetchRemote(jira, { key: 'OPS-7', ref: null })).toMatchObject({ category: 'done', assignee: null });
  });

  it('says what happened when the ticket is gone or the credentials are refused, never the secret', async () => {
    fake({ 'GET /rest/api/2/issue/OPS-7': reply(404, {}) });
    await expect(fetchRemote(jira, { key: 'OPS-7', ref: null })).rejects.toThrow(/no longer has this ticket/);
    fake({ 'GET /rest/api/2/issue/OPS-7': reply(401, {}) });
    const err = await fetchRemote(jira, { key: 'OPS-7', ref: null }).catch((e) => e);
    expect(err.message).toMatch(/refused the credentials/);
    expect(err.message).not.toContain('s3cret');
  });

  it('refuses a key that is not a Jira key before calling anything', async () => {
    fake({});
    await expect(fetchRemote(jira, { key: '../../etc', ref: null })).rejects.toThrow(/not valid/);
    expect(calls).toHaveLength(0);
  });

  it('posts a comment, lists transitions and moves the ticket', async () => {
    fake({
      'POST /rest/api/2/issue/OPS-7/comment': reply(201, { id: '55' }),
      'GET /rest/api/2/issue/OPS-7/transitions': reply(200, { transitions: [{ id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } }] }),
      'POST /rest/api/2/issue/OPS-7/transitions': reply(204),
    });
    expect(await addComment(jira, { key: 'OPS-7', ref: null }, 'hello')).toEqual({ id: '55' });
    expect(await listTransitions(jira, { key: 'OPS-7', ref: null })).toEqual([{ id: '31', name: 'Done', to: 'Done', category: 'done' }]);
    await transitionTicket(jira, { key: 'OPS-7', ref: null }, '31');
    expect(JSON.parse(calls[2].body!)).toEqual({ transition: { id: '31' } });
  });

  it('only accepts a numeric transition id', async () => {
    fake({});
    await expect(transitionTicket(jira, { key: 'OPS-7', ref: null }, '31; drop')).rejects.toThrow(/Invalid/);
  });
});

describe('following a ServiceNow incident', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const sysId = 'a'.repeat(32);

  it('reads the state label and category, and customer-visible comments only', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: URL) => {
      seen.push(decodeURIComponent(url.toString()));
      if (url.pathname.includes('sys_journal_field')) return reply(200, { result: [{ sys_id: 'j1', value: 'Customer note', sys_created_by: 'amy', sys_created_on: '2026-10-13 09:00:00' }] });
      return reply(200, { result: { state: { value: '2', display_value: 'In Progress' }, priority: { display_value: '2 - High' }, assigned_to: { display_value: 'Bo' }, sys_updated_on: { value: '2026-10-13 10:00:00' } } });
    });
    const r = await fetchRemote(snow, { key: 'INC001', ref: sysId });
    expect(r).toMatchObject({ status: 'In Progress', category: 'in_progress', assignee: 'Bo', priority: '2 - High' });
    expect(r.comments[0]).toMatchObject({ id: 'j1', author: 'amy', createdAt: '2026-10-13T09:00:00.000Z' });
    expect(seen.some((u) => u.includes('element=comments'))).toBe(true);
    expect(seen.some((u) => u.includes('work_notes'))).toBe(false);
  });

  it('still syncs the ticket when journals cannot be read', async () => {
    vi.stubGlobal('fetch', async (url: URL) => (url.pathname.includes('sys_journal_field') ? reply(403, {}) : reply(200, { result: { state: { value: '6', display_value: 'Resolved' } } })));
    const r = await fetchRemote(snow, { key: 'INC001', ref: sysId });
    expect(r.category).toBe('done');
    expect(r.comments).toEqual([]);
  });

  it('needs the record id, and will not change status from the portal', async () => {
    await expect(fetchRemote(snow, { key: 'INC001', ref: null })).rejects.toThrow(/no record id/);
    await expect(transitionTicket(snow, { key: 'INC001', ref: sysId }, '1')).rejects.toThrow(/in ServiceNow/);
    expect(await listTransitions(snow, { key: 'INC001', ref: sysId })).toEqual([]);
  });
});

describe('nextSyncMinutes', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  it('polls often when new, calmer as it ages, never when done', () => {
    expect(nextSyncMinutes('2026-10-13T08:00:00Z', 'open', now)).toBe(5);
    expect(nextSyncMinutes('2026-10-10T08:00:00Z', 'in_progress', now)).toBe(30);
    expect(nextSyncMinutes('2026-09-01T08:00:00Z', 'open', now)).toBe(120);
    expect(nextSyncMinutes('2026-10-13T08:00:00Z', 'done', now)).toBeNull();
  });
});
