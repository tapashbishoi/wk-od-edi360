import { describe, it, expect } from 'vitest';
import { csvCell } from './csv.js';

describe('csvCell', () => {
  it('leaves plain values alone and empties null/undefined', () => {
    expect(csvCell('Acme Retail')).toBe('Acme Retail');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('Smith, John')).toBe('"Smith, John"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it.each(['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])('defuses formula-like %j', (v) => {
    expect(csvCell(v).replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('does not touch a negative-looking value that is not at the start', () => {
    expect(csvCell('a-b=c')).toBe('a-b=c');
  });

  it('writes dates as ISO text', () => {
    expect(csvCell(new Date('2026-10-07T12:00:00Z'))).toBe('2026-10-07T12:00:00.000Z');
  });
});
