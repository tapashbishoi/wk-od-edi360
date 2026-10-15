import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { encryptSecret } from '../utils/crypto.js';

const rows: { current: any } = { current: null };
vi.mock('../db/connection.js', () => ({ queryOne: vi.fn(async () => rows.current), query: vi.fn(), transaction: vi.fn() }));

import { sendTenantEmail, brevoConfig, escapeHtml } from './email.service.js';

const mail = { to: 'jane@nordic.com', toName: 'Jane', subject: 'Hello', html: '<p>Hi</p>', text: 'Hi' };
const respond = (status: number, body: unknown = {}) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  rows.current = { secret_enc: encryptSecret('brevo-key-secret'), extra: { senderEmail: 'alerts@nordic.com' } };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendTenantEmail', () => {
  it('sends through the tenant\'s own Brevo key and sender address', async () => {
    const f = respond(201, { messageId: 'x' });
    vi.stubGlobal('fetch', f);

    expect(await sendTenantEmail(5, mail)).toEqual({ sent: true });

    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.headers['api-key']).toBe('brevo-key-secret');
    const body = JSON.parse(init.body);
    expect(body.sender.email).toBe('alerts@nordic.com');
    expect(body.to).toEqual([{ email: 'jane@nordic.com', name: 'Jane' }]);
    expect(body.subject).toBe('Hello');
    expect(body.htmlContent).toBe('<p>Hi</p>');
  });

  it('reports "not set up" without calling Brevo when the tenant has no key', async () => {
    rows.current = null;
    const f = respond(201);
    vi.stubGlobal('fetch', f);
    const r = await sendTenantEmail(5, mail);
    expect(r.sent).toBe(false);
    expect(r.error).toMatch(/not set up/);
    expect(f).not.toHaveBeenCalled();
  });

  it('treats a key with no sender address as not set up', async () => {
    rows.current = { secret_enc: encryptSecret('k-12345678'), extra: {} };
    expect(await brevoConfig(5)).toBeNull();
  });

  it('treats a key saved under another encryption key as not set up, not a crash', async () => {
    rows.current = { secret_enc: 'v1:bad:bad:bad', extra: { senderEmail: 'a@b.com' } };
    expect(await brevoConfig(5)).toBeNull();
  });

  it('returns Brevo\'s reason on a rejection, and never the key', async () => {
    vi.stubGlobal('fetch', respond(401, { message: 'Key not found' }));
    const r = await sendTenantEmail(5, mail);
    expect(r.sent).toBe(false);
    expect(r.error).toContain('401');
    expect(r.error).toContain('Key not found');
    expect(r.error).not.toContain('brevo-key-secret');
  });

  it('does not throw on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const r = await sendTenantEmail(5, mail);
    expect(r.sent).toBe(false);
    expect(r.error).toMatch(/Could not reach Brevo/);
  });
});

describe('escapeHtml', () => {
  it('escapes the characters that matter', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});
