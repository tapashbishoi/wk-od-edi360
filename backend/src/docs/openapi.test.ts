import { describe, it, expect } from 'vitest';
import { createApp } from '../app.js';
import { ENDPOINTS, buildOpenApi } from './openapi.js';
import { listRoutes } from './routes.js';

// {tenantId} and {id} are the same thing as the {} the route lister writes
const key = (m: string, p: string) => `${m.toUpperCase()} /api${p.replace(/\{\w+\}/g, '{}')}`;

describe('OpenAPI description', () => {
  const served = listRoutes(createApp());
  const documented = ENDPOINTS.map((e) => key(e.m, e.p));

  it('documents every route the app serves', () => {
    expect(served.filter((r) => !documented.includes(r))).toEqual([]);
  });

  it('documents nothing the app does not serve', () => {
    expect(documented.filter((r) => !served.includes(r))).toEqual([]);
  });

  it('lists each endpoint once', () => {
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('is a well-formed OpenAPI document', () => {
    const spec = buildOpenApi();
    expect(spec.openapi).toBe('3.0.3');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(40);
    for (const [path, ops] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(ops)) {
        expect(op.summary, `${method} ${path}`).toBeTruthy();
        expect(Object.keys(op.responses).length, `${method} ${path}`).toBeGreaterThan(0);
        // every {param} in the path is declared
        for (const m of path.matchAll(/\{(\w+)\}/g)) expect(op.parameters?.some((p: any) => p.name === m[1] && p.in === 'path'), `${method} ${path} {${m[1]}}`).toBe(true);
      }
    }
  });

  it('marks public endpoints as needing no credentials and ingest as API-key', () => {
    const spec = buildOpenApi();
    expect(spec.paths['/health'].get.security).toEqual([]);
    expect(spec.paths['/auth/login'].post.security).toEqual([]);
    expect(spec.paths['/v1/ingest/workato'].post.security).toEqual([{ apiKeyAuth: [] }]);
    expect(spec.paths['/platform/health'].get.security).toEqual([{ bearerAuth: [] }]);
  });
});
