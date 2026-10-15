import { describe, it, expect } from 'vitest';
import { normalizeView, parseViewParam, viewWhere } from './savedView.js';

describe('normalizeView', () => {
  it('trims, uppercases types and drops malformed entries', () => {
    expect(normalizeView([{ partner: ' WMT ', types: ['850', ' 856 ', 'bad type!', ''] }, { partner: '' }, null, 'x'])).toEqual([{ partner: 'WMT', types: ['850', '856'] }]);
  });
  it('is empty for anything that is not an array', () => {
    expect(normalizeView(undefined)).toEqual([]);
    expect(normalizeView({ partner: 'A' })).toEqual([]);
  });
  it('merges a partner listed twice, and lets "every type" absorb a narrower pick', () => {
    expect(normalizeView([{ partner: 'A', types: ['850'] }, { partner: 'A', types: ['856'] }])).toEqual([{ partner: 'A', types: ['850', '856'] }]);
    expect(normalizeView([{ partner: 'A', types: ['850'] }, { partner: 'A', types: [] }])).toEqual([{ partner: 'A', types: [] }]);
  });
  it('caps the number of pairs', () => {
    expect(normalizeView(Array.from({ length: 80 }, (_, i) => ({ partner: `P${i}` })))).toHaveLength(50);
  });
});

describe('parseViewParam', () => {
  it('reads the query-string form', () => {
    expect(parseViewParam('WMT:850,860|TGT')).toEqual([{ partner: 'WMT', types: ['850', '860'] }, { partner: 'TGT', types: [] }]);
  });
  it('treats empty or non-string input as no view', () => {
    expect(parseViewParam('')).toEqual([]);
    expect(parseViewParam(undefined)).toEqual([]);
    expect(parseViewParam(['a'])).toEqual([]);
  });
});

describe('viewWhere', () => {
  it('is null for an empty view and touches no parameters', () => {
    const params: any[] = [];
    expect(viewWhere([], params)).toBeNull();
    expect(params).toEqual([]);
  });
  it('pairs partners with their own types, so one partner\'s types do not leak to another', () => {
    const params: any[] = [1];
    const sql = viewWhere([{ partner: 'WMT', types: ['850'] }, { partner: 'TGT', types: [] }], params)!;
    expect(params).toEqual([1, 'WMT', ['850'], 'TGT']);
    expect(sql).toBe(`((CASE t.direction WHEN 'inbound' THEN t.sender_id ELSE t.receiver_id END = $2 AND t.document_type = ANY($3)) OR (CASE t.direction WHEN 'inbound' THEN t.sender_id ELSE t.receiver_id END = $4))`);
  });
});
