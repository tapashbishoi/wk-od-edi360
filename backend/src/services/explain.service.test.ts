import { describe, it, expect } from 'vitest';
import { allowExplainRequest, hashEdi, sanitizeGeneratedHtml } from './explain.service.js';

describe('sanitizeGeneratedHtml', () => {
  it('strips code fences, scripts, styles, frames, handlers, links and remote images', () => {
    const dirty = '```html\n<div onclick="x()" style="color:red;background:url(http://evil/x)"><script>alert(1)</script><style>a{}</style><iframe src="//e"></iframe><img src=x onerror=alert(1)><a href="javascript:alert(1)">hi</a><a href="https://e.com">e</a><p>ok</p></div>\n```';
    const clean = sanitizeGeneratedHtml(dirty);
    expect(clean).not.toMatch(/script|onclick|onerror|iframe|<img|href|url\(|```|<style/i);
    expect(clean).toContain('<p>ok</p>');
    expect(clean).toContain('color:red');
  });
  it('leaves ordinary tables alone', () => {
    const html = '<table style="width:100%"><tr><td style="padding:8px">Qty</td><td>5</td></tr></table>';
    expect(sanitizeGeneratedHtml(html)).toBe(html);
  });
});

describe('hashEdi', () => {
  it('is stable and changes with the content', () => {
    expect(hashEdi('a')).toBe(hashEdi('a'));
    expect(hashEdi('a')).not.toBe(hashEdi('b'));
    expect(hashEdi('a')).toHaveLength(64);
  });
});

describe('allowExplainRequest', () => {
  it('allows 20 a minute per tenant, separately for each tenant, and recovers', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) expect(allowExplainRequest(9001, t0 + i)).toBe(true);
    expect(allowExplainRequest(9001, t0 + 100)).toBe(false);
    expect(allowExplainRequest(9002, t0 + 100)).toBe(true);
    expect(allowExplainRequest(9001, t0 + 61_000)).toBe(true);
  });
});
