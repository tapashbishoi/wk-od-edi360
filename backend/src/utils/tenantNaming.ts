/**
 * Tenant slug and queue naming.
 *
 * Queue names are derived from the slug, never typed free-form, so a name the
 * broker would reject can't be saved. Slug rules sit inside the AMQP name
 * charset and match the CHECK on wk_tenants.slug.
 */

export const QUEUE_PREFIX = 'workato_';

const SLUG = /^[a-z][a-z0-9_]{1,40}$/;

/** Returns an error message, or null when the slug is acceptable. */
export function validateSlug(raw: unknown): string | null {
  if (typeof raw !== 'string' || !SLUG.test(raw)) {
    return 'Slug must start with a letter and use 2-41 lowercase letters, digits or underscores';
  }
  return null;
}

export function queueNameFor(slug: string): string {
  return `${QUEUE_PREFIX}${slug}`;
}

export function dlqNameFor(slug: string): string {
  return `${queueNameFor(slug)}.dlq`;
}
