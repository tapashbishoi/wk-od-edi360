import { describe, it, expect } from 'vitest';
import { hashToken, newToken, normalizeEmail, inviteUrl, inviteEmail, isMemberRole, MEMBER_ROLES, INVITE_TTL_DAYS } from './members.service.js';

describe('invitation tokens', () => {
  it('are long, URL-safe and unique', () => {
    const a = newToken();
    const b = newToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40); // 256 bits
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('are stored only as a SHA-256, which is stable and never the token itself', () => {
    const t = newToken();
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toContain(t);
    expect(hashToken(t)).not.toBe(hashToken(newToken()));
  });

  it('build a link on the portal URL', () => {
    expect(inviteUrl('abc')).toBe('http://localhost:5174/invite/abc');
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Jane.Doe@Nordic.COM ')).toBe('jane.doe@nordic.com');
  });
  it.each(['', 'no-at-sign', 'a@b', 'two words@x.com', null, undefined, 42, 'a@b.c'.padEnd(300, 'x')])('rejects %j', (v) => {
    expect(normalizeEmail(v as any)).toBeNull();
  });
});

describe('roles', () => {
  it('are the four tenant roles and never platform_admin', () => {
    expect([...MEMBER_ROLES]).toEqual(['customer_admin', 'support', 'business', 'auditor']);
    expect(isMemberRole('support')).toBe(true);
    expect(isMemberRole('platform_admin')).toBe(false);
    expect(isMemberRole('root')).toBe(false);
    expect(isMemberRole(undefined)).toBe(false);
  });
});

describe('inviteEmail', () => {
  it('carries the link, the tenant and the expiry', () => {
    const m = inviteEmail({ tenantName: 'Nordic Naturals', firstName: 'Jane', url: 'https://portal.test/invite/xyz', invitedBy: 'admin@ut.com' });
    expect(m.subject).toContain('Nordic Naturals');
    expect(m.html).toContain('https://portal.test/invite/xyz');
    expect(m.html).toContain(`${INVITE_TTL_DAYS} days`);
    expect(m.text).toContain('https://portal.test/invite/xyz');
  });

  it('escapes names so a hostile one cannot inject markup', () => {
    const m = inviteEmail({ tenantName: '<img src=x onerror=alert(1)>', firstName: '"><script>alert(1)</script>', url: 'https://p.test/i/x' });
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;script&gt;');
  });
});
