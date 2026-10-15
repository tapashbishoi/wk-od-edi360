import { describe, it, expect } from 'vitest';
import { describeView, serialiseView, setCurrentView, viewParam } from './savedView';

describe('savedView', () => {
  it('serialises pairs for the query string', () => {
    expect(serialiseView([{ partner: 'WMT', types: ['850', '856'] }, { partner: 'TGT', types: [] }])).toBe('WMT:850,856|TGT');
    expect(serialiseView([])).toBeUndefined();
  });
  it('is read by the API client from whatever was last set, and cleared by an empty view', () => {
    setCurrentView([{ partner: 'A', types: ['810'] }]);
    expect(viewParam()).toBe('A:810');
    setCurrentView(undefined);
    expect(viewParam()).toBeUndefined();
  });
  it('describes a view with partner names when known', () => {
    expect(describeView([{ partner: 'WMT', types: ['850'] }, { partner: 'X', types: [] }], { WMT: 'Walmart' })).toBe('Walmart (850) · X');
  });
});
