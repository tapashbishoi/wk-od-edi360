import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { createApp } from './app.js';
import { AuthService } from './services/auth.service.js';

describe('the user guide', () => {
  let server: Server;
  let base: string;

  beforeAll(() => {
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });

  it('is not served to someone who is not signed in', async () => {
    const r = await fetch(`${base}/api/help/user-guide.pdf`);
    expect(r.status).toBe(401);
  });

  it('is not served for a bad token', async () => {
    const r = await fetch(`${base}/api/help/user-guide.pdf`, { headers: { Authorization: 'Bearer nonsense' } });
    expect(r.status).toBe(401);
  });

  it('is served as a PDF to a signed-in user', async () => {
    const token = AuthService.generateAccessToken({ userId: 'u1', email: 'a@b.co', role: 'platform_admin', tenantId: null });
    const r = await fetch(`${base}/api/help/user-guide.pdf`, { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(10_000);
  });
});
