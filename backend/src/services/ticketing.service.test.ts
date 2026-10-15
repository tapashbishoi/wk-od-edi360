import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTicket, normalizeConfig, testConnection, TicketError, type TicketConfig } from './ticketing.service.js';
import { assertSafeHttpsUrl, isPrivateAddress, UnsafeUrlError } from '../utils/urlGuard.js';

// Public IP literals, so no test needs DNS
const JIRA = 'https://198.51.100.7';
const SNOW = 'https://203.0.113.9';

const jira = (over: Partial<TicketConfig> = {}): TicketConfig => ({
  provider: 'jira', baseUrl: JIRA, email: 'svc@yourco.com', projectKey: 'OPS', issueType: 'Task', secret: 'tok-secret-123',
  priorityNames: { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' }, ...over,
}) as TicketConfig;
const snow = (over: Record<string, unknown> = {}): TicketConfig => ({ provider: 'servicenow', baseUrl: SNOW, username: 'svc', secret: 'pw-secret-123', ...over }) as TicketConfig;

const respond = (status: number, body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
afterEach(() => { vi.unstubAllGlobals(); });

describe('isPrivateAddress / assertSafeHttpsUrl', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1'])('treats %s as not public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '198.51.100.7', '172.32.0.1', '2606:4700::1111'])('treats %s as public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it('refuses http, embedded credentials, odd ports, and internal addresses', async () => {
    await expect(assertSafeHttpsUrl('http://198.51.100.7')).rejects.toThrow(/https/);
    await expect(assertSafeHttpsUrl('https://user:pw@198.51.100.7')).rejects.toThrow(/user name/);
    await expect(assertSafeHttpsUrl('https://198.51.100.7:8443')).rejects.toThrow(/port/);
    await expect(assertSafeHttpsUrl('https://127.0.0.1')).rejects.toThrow(UnsafeUrlError);
    await expect(assertSafeHttpsUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/public internet/);
    await expect(assertSafeHttpsUrl('https://[::1]/')).rejects.toThrow(/public internet/);
    await expect(assertSafeHttpsUrl('not a url')).rejects.toThrow(/valid URL/);
  });
  it('accepts a public https address', async () => {
    expect((await assertSafeHttpsUrl('https://198.51.100.7/path')).hostname).toBe('198.51.100.7');
  });
});

describe('normalizeConfig', () => {
  it('cleans a Jira connection, keeping only the site address, with default priorities', async () => {
    const c = await normalizeConfig('jira', { baseUrl: `${JIRA}/jira/some/path?x=1`, email: ' svc@yourco.com ', projectKey: 'ops', issueType: '' });
    expect(c).toMatchObject({ provider: 'jira', baseUrl: JIRA, email: 'svc@yourco.com', projectKey: 'OPS', issueType: 'Task' });
    expect((c as any).priorityNames).toEqual({ critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' });
  });
  it('takes the project\'s own priority names', async () => {
    const c = await normalizeConfig('jira', { baseUrl: JIRA, email: 'a@b.co', projectKey: 'OPS', priorityNames: { critical: 'P1', high: 'P2' } });
    expect((c as any).priorityNames).toMatchObject({ critical: 'P1', high: 'P2', medium: 'Medium' });
  });
  it.each([
    ['jira', { baseUrl: JIRA, email: 'nope', projectKey: 'OPS' }, /email/],
    ['jira', { baseUrl: JIRA, email: 'a@b.co', projectKey: '1x' }, /project key/],
    ['jira', { baseUrl: 'http://198.51.100.7', email: 'a@b.co', projectKey: 'OPS' }, /https/],
    ['jira', { baseUrl: 'https://127.0.0.1', email: 'a@b.co', projectKey: 'OPS' }, /public internet/],
    ['jira', { email: 'a@b.co', projectKey: 'OPS' }, /required/],
    ['servicenow', { baseUrl: SNOW, username: '' }, /user name/],
    ['servicenow', { baseUrl: SNOW, username: 'svc', assignmentGroup: 'not-a-sys-id' }, /sys_id/],
    ['trello', {}, /Jira or ServiceNow/],
  ])('rejects %s %j', async (provider, input, message) => {
    await expect(normalizeConfig(provider, input)).rejects.toThrow(TicketError);
    await expect(normalizeConfig(provider, input)).rejects.toThrow(message);
  });
});

describe('createTicket - Jira', () => {
  it('posts the issue with basic auth, project, type, priority and a label, and returns its link', async () => {
    const f = respond(201, { id: '10001', key: 'OPS-42' });
    vi.stubGlobal('fetch', f);
    const out = await createTicket(jira(), { summary: 'S', description: 'D', priority: 'high' });
    expect(out).toEqual({ key: 'OPS-42', url: `${JIRA}/browse/OPS-42` });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe(`${JIRA}/rest/api/2/issue`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('svc@yourco.com:tok-secret-123').toString('base64')}`);
    expect(JSON.parse(init.body).fields).toMatchObject({ project: { key: 'OPS' }, issuetype: { name: 'Task' }, summary: 'S', description: 'D', priority: { name: 'High' }, labels: ['edi-portal'] });
  });

  it('still raises the ticket when the project has no such priority, putting it in the text', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: { priority: 'Priority name is not valid' } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ key: 'OPS-43' }), { status: 201 }));
    vi.stubGlobal('fetch', f);
    const out = await createTicket(jira(), { summary: 'S', description: 'D', priority: 'critical' });
    expect(out.key).toBe('OPS-43');
    const retry = JSON.parse(f.mock.calls[1][1].body).fields;
    expect(retry.priority).toBeUndefined();
    expect(retry.description).toMatch(/^Priority: CRITICAL/);
  });

  it('explains a bad token without repeating it, and a missing project', async () => {
    vi.stubGlobal('fetch', respond(401, {}));
    const e1 = await createTicket(jira(), { summary: 'S', description: 'D', priority: 'low' }).catch((e) => e);
    expect(e1).toBeInstanceOf(TicketError);
    expect(e1.message).toMatch(/refused the credentials/);
    expect(e1.message).not.toContain('tok-secret-123');
    vi.stubGlobal('fetch', respond(400, { errors: { project: 'valid project is required' } }));
    await expect(createTicket(jira(), { summary: 'S', description: 'D', priority: 'low' })).rejects.toThrow(/valid project is required/);
  });

  it('will not follow a redirect, and does not leak the credentials when the call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed: unexpected redirect')));
    const e = await createTicket(jira(), { summary: 'S', description: 'D', priority: 'low' }).catch((x) => x);
    expect(e.message).toMatch(/redirected/);
    expect(e.message).not.toContain('tok-secret-123');
  });

  it('refuses to call an address that has since become internal', async () => {
    const f = respond(201, {});
    vi.stubGlobal('fetch', f);
    await expect(createTicket(jira({ baseUrl: 'https://169.254.169.254' } as any), { summary: 'S', description: 'D', priority: 'low' })).rejects.toThrow(/cannot be used/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('createTicket - ServiceNow', () => {
  it('creates an incident from impact and urgency, and links to it', async () => {
    const f = respond(201, { result: { number: 'INC0012345', sys_id: 'abc123' } });
    vi.stubGlobal('fetch', f);
    const out = await createTicket(snow({ category: 'Software', assignmentGroup: 'a'.repeat(32) }), { summary: 'S', description: 'D', priority: 'critical' });
    expect(out.key).toBe('INC0012345');
    expect(out.url).toBe(`${SNOW}/nav_to.do?uri=${encodeURIComponent('incident.do?sys_id=abc123')}`);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe(`${SNOW}/api/now/table/incident`);
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('svc:pw-secret-123').toString('base64')}`);
    expect(JSON.parse(init.body)).toMatchObject({ short_description: 'S', description: 'D', impact: '1', urgency: '1', category: 'Software', assignment_group: 'a'.repeat(32) });
  });

  it.each([['high', '2', '1'], ['medium', '2', '2'], ['low', '3', '3']] as const)('maps %s to impact %s, urgency %s', async (priority, impact, urgency) => {
    const f = respond(201, { result: { number: 'INC1', sys_id: 'x' } });
    vi.stubGlobal('fetch', f);
    await createTicket(snow(), { summary: 'S', description: 'D', priority });
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ impact, urgency });
  });

  it('reports ServiceNow\'s own message when it refuses', async () => {
    vi.stubGlobal('fetch', respond(400, { error: { message: 'Invalid assignment group' } }));
    await expect(createTicket(snow(), { summary: 'S', description: 'D', priority: 'low' })).rejects.toThrow(/Invalid assignment group/);
  });
});

describe('testConnection', () => {
  it('reads who we are in Jira, and creates nothing', async () => {
    const f = respond(200, { displayName: 'Service Account' });
    vi.stubGlobal('fetch', f);
    expect(await testConnection(jira())).toEqual({ ok: true, detail: 'Connected as Service Account' });
    expect(f.mock.calls[0][1].method).toBe('GET');
    expect(String(f.mock.calls[0][0])).toContain('/rest/api/2/myself');
  });
  it('says what is wrong when the credentials are refused', async () => {
    vi.stubGlobal('fetch', respond(401, {}));
    expect(await testConnection(snow())).toMatchObject({ ok: false, detail: expect.stringMatching(/refused the credentials/) });
  });
});
