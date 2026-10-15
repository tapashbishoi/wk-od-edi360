import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';

describe('serving the built frontend (production image)', () => {
  let server: Server;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edi360-site-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>EDI360 page</html>');
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
    process.env.FRONTEND_DIST = dir;
    vi.resetModules();
    const { createApp } = await import('./app.js');
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server.close();
    delete process.env.FRONTEND_DIST;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves a built file', async () => {
    const r = await fetch(`${base}/assets/app.js`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('console.log(1)');
  });

  it('serves the page for a client-side address, so a refresh works', async () => {
    const r = await fetch(`${base}/transactions/12`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('EDI360 page');
  });

  it('keeps unknown API addresses as JSON 404s, not the page', async () => {
    const r = await fetch(`${base}/api/nope`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'Not found' });
  });

  it('answers a missing file with a 404, not the page', async () => {
    const r = await fetch(`${base}/logos/missing.svg`);
    expect(r.status).toBe(404);
  });

  it('does not answer a POST to a page address with the page', async () => {
    const r = await fetch(`${base}/transactions`, { method: 'POST' });
    expect(r.status).toBe(404);
  });
});
