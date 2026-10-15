import { env } from '../config/env.js';

/**
 * Orderful API client. Only /v3/convert for now (JSON message -> raw X12).
 *
 * Request shape taken from a working Postman call:
 *   POST /v3/convert
 *   Accept: application/edi-x12 | Content-Type: application/json | orderful-api-key: <key>
 *   body: the X12-JSON message itself (interchangeControlHeader, functionalGroupHeader, transactionSets)
 *   201 -> a JSON array of strings, one raw X12 interchange each
 *
 * Failures are classified, because the worker must treat them differently:
 *   auth      401/403  retry only after the credential is replaced
 *   invalid   400/422  the message itself is bad; retrying can't help
 *   transient 429/5xx/network/timeout  retry with backoff
 * Error text never includes the request body: it contains the customer's order.
 */

export class OrderfulError extends Error {
  constructor(public kind: 'auth' | 'invalid' | 'transient', message: string, public status?: number) {
    super(message);
  }
}

const TIMEOUT_MS = 30000;

/** Orderful's error bodies are small JSON; keep a bounded, body-free summary. */
async function describeFailure(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 300);
    const parsed = JSON.parse(text);
    const msg = parsed?.message ?? parsed?.error ?? parsed?.errors?.[0]?.message;
    if (typeof msg === 'string') return msg.slice(0, 200);
  } catch {
    /* not JSON */
  }
  return res.statusText || 'no detail';
}

/** Converts an X12-JSON message to raw X12. Returns the interchanges joined by a newline. */
export async function convertToX12(apiKey: string, message: unknown): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${env.ORDERFUL_API_URL}/v3/convert`, {
      method: 'POST',
      headers: {
        Accept: 'application/edi-x12',
        'Content-Type': 'application/json',
        'orderful-api-key': apiKey,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error: any) {
    // Never include error.cause/URL details beyond the message: no request data is in it
    throw new OrderfulError('transient', `Orderful unreachable: ${error?.name === 'TimeoutError' ? 'timed out' : error?.message ?? 'network error'}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new OrderfulError('auth', `Orderful rejected the API key (${res.status})`, res.status);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new OrderfulError('transient', `Orderful ${res.status}: ${await describeFailure(res)}`, res.status);
  }
  if (!res.ok) {
    throw new OrderfulError('invalid', `Orderful ${res.status}: ${await describeFailure(res)}`, res.status);
  }

  let body: unknown;
  try {
    // Accept is application/edi-x12 but the sample response is JSON; read the text and be tolerant of both
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } catch {
    throw new OrderfulError('transient', 'Orderful response could not be read', res.status);
  }

  const parts = Array.isArray(body) ? body.filter((p): p is string => typeof p === 'string') : typeof body === 'string' ? [body] : [];
  const edi = parts.join('\n').trim();
  if (!edi.startsWith('ISA') && !edi.startsWith('UNB') && !edi.startsWith('UNA')) {
    throw new OrderfulError('invalid', 'Orderful returned something that is not raw EDI', res.status);
  }
  return edi;
}

/** Retry delays after a transient failure: 2, 15, 60 minutes, then give up. */
const BACKOFF_MINUTES = [2, 15, 60];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;

/** Minutes to wait before the next attempt, or null when attempts are exhausted. */
export function backoffMinutes(attemptsSoFar: number): number | null {
  return BACKOFF_MINUTES[attemptsSoFar - 1] ?? null;
}

/**
 * Fetches one transaction: GET /v3/transactions/{id}. For a transaction WE sent this is the only place
 * its validation, delivery and acknowledgment status live; the Workato log just says it was created.
 * Returns the parsed transaction object. Same failure classes as convert; 404 is "invalid" (no such
 * transaction for this key), which retrying cannot fix.
 */
export async function getTransaction(apiKey: string, transactionId: string): Promise<Record<string, any>> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(transactionId)) throw new OrderfulError('invalid', 'Not a valid Orderful transaction id');
  let res: Response;
  try {
    res = await fetch(`${env.ORDERFUL_API_URL}/v3/transactions/${encodeURIComponent(transactionId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'orderful-api-key': apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error: any) {
    throw new OrderfulError('transient', `Orderful unreachable: ${error?.name === 'TimeoutError' ? 'timed out' : error?.message ?? 'network error'}`);
  }

  if (res.status === 401 || res.status === 403) throw new OrderfulError('auth', `Orderful rejected the API key (${res.status})`, res.status);
  if (res.status === 404) throw new OrderfulError('invalid', 'Orderful has no such transaction for this API key (404)', 404);
  if (res.status === 429 || res.status >= 500) throw new OrderfulError('transient', `Orderful ${res.status}: ${await describeFailure(res)}`, res.status);
  if (!res.ok) throw new OrderfulError('invalid', `Orderful ${res.status}: ${await describeFailure(res)}`, res.status);

  try {
    const body = JSON.parse(await res.text());
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.id === undefined) throw new Error('shape');
    return body;
  } catch {
    throw new OrderfulError('transient', 'Orderful response could not be read', res.status);
  }
}
