import { describe, it, expect } from 'vitest';
import { validateSlug, queueNameFor, dlqNameFor } from './tenantNaming.js';

describe('tenantNaming', () => {
  it('derives the queue and dead-letter names from the slug', () => {
    expect(queueNameFor('nordic_naturals')).toBe('workato_nordic_naturals');
    expect(dlqNameFor('nordic_naturals')).toBe('workato_nordic_naturals.dlq');
  });

  it('accepts sensible slugs', () => {
    expect(validateSlug('nordic_naturals')).toBeNull();
    expect(validateSlug('acme2')).toBeNull();
  });

  it.each(['', 'a', 'Nordic', '1acme', 'has space', 'dash-ed', 'x'.repeat(42), 'amq.x', null, 42])(
    'rejects %j',
    (slug) => {
      expect(validateSlug(slug as any)).not.toBeNull();
    }
  );
});
