import { describe, it, expect, vi, afterEach } from 'vitest';
import { isFinal, nextCheckMinutes, observedFrom } from './orderfulStatus.service.js';
import { getTransaction, OrderfulError } from './orderful.client.js';

// What GET /v3/transactions/1072185498 returned for the real outbound 855
const RESPONSE = {
  id: '1072185498', version: 'v3',
  sender: { isaId: 'UNITEDTECHNO', name: 'United Techno Demo' },
  receiver: { isaId: 'ODFLRETAILTEST', name: 'Retail Integration Testing' },
  type: { name: '855_PURCHASE_ORDER_ACKNOWLEDGMENT' }, stream: 'TEST', businessNumber: '100',
  referenceIdentifiers: [{ value: '238', type: 'GROUP', owner: 'RECEIVER' }, { value: '000000238', type: 'INTERCHANGE', owner: 'RECEIVER' }],
  validationStatus: 'INVALID', deliveryStatus: 'PENDING', acknowledgmentStatus: 'NOT_ACKNOWLEDGED',
  createdAt: '2026-10-09T04:27:47.828Z', lastUpdatedAt: '2026-10-09T04:27:47.991Z',
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('observedFrom', () => {
  it('lifts the partners, statuses and business number out of Orderful\'s response', () => {
    expect(observedFrom(RESPONSE)).toMatchObject({
      transactionId: '1072185498', senderName: 'United Techno Demo', receiverName: 'Retail Integration Testing', businessNumber: '100',
      validationStatus: 'INVALID', deliveryStatus: 'PENDING', acknowledgmentStatus: 'NOT_ACKNOWLEDGED', documentType: '855', stream: 'TEST',
    });
  });
  it('leaves out Orderful\'s control numbers: they are the receiver\'s, not what was sent', () => {
    const o = observedFrom(RESPONSE)!;
    expect(o).not.toHaveProperty('isaControlNumber');
    expect(o).not.toHaveProperty('gsControlNumber');
  });
  it('is null for something that is not a transaction', () => {
    expect(observedFrom({ nope: true })).toBeNull();
  });
});

describe('isFinal', () => {
  it('is final once invalid, failed, or delivered and answered by the partner', () => {
    expect(isFinal({ validation: 'INVALID' })).toBe(true);
    expect(isFinal({ delivery: 'FAILED' })).toBe(true);
    expect(isFinal({ delivery: 'DELIVERED', ack: 'ACCEPTED' })).toBe(true);
    expect(isFinal({ delivery: 'DELIVERED', ack: 'REJECTED' })).toBe(true);
  });
  it('keeps asking while it is pending, sent, or delivered but unacknowledged', () => {
    expect(isFinal({ validation: 'VALID', delivery: 'PENDING', ack: 'NOT_ACKNOWLEDGED' })).toBe(false);
    expect(isFinal({ delivery: 'SENT' })).toBe(false);
    expect(isFinal({ delivery: 'DELIVERED', ack: 'NOT_ACKNOWLEDGED' })).toBe(false);
    expect(isFinal({})).toBe(false);
  });
});

describe('nextCheckMinutes', () => {
  it('asks often while new and rarely once it has waited', () => {
    expect(nextCheckMinutes(2)).toBe(1);
    expect(nextCheckMinutes(60)).toBe(10);
    expect(nextCheckMinutes(600)).toBe(120);
  });
});

describe('getTransaction', () => {
  const respond = (status: number, body: unknown) => vi.fn().mockResolvedValue(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

  it('sends the API key in the orderful-api-key header to /v3/transactions/{id}', async () => {
    const f = respond(200, RESPONSE);
    vi.stubGlobal('fetch', f);
    expect((await getTransaction('key-1', '1072185498')).validationStatus).toBe('INVALID');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.orderful.com/v3/transactions/1072185498');
    expect(init.method).toBe('GET');
    expect(init.headers['orderful-api-key']).toBe('key-1');
  });

  it.each([[401, 'auth'], [403, 'auth'], [404, 'invalid'], [429, 'transient'], [503, 'transient'], [400, 'invalid']])('classifies HTTP %i as %s', async (status, kind) => {
    vi.stubGlobal('fetch', respond(status, { message: 'nope' }));
    await expect(getTransaction('k', '1')).rejects.toMatchObject({ kind });
  });

  it('refuses an id that could change the path, without calling Orderful', async () => {
    const f = respond(200, RESPONSE);
    vi.stubGlobal('fetch', f);
    await expect(getTransaction('k', '1/../../v3/convert')).rejects.toBeInstanceOf(OrderfulError);
    expect(f).not.toHaveBeenCalled();
  });

  it('is transient for a network failure or an unreadable body, and never repeats the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));
    const err = await getTransaction('secret-key', '1').catch((e) => e);
    expect(err.kind).toBe('transient');
    expect(err.message).not.toContain('secret-key');
    vi.stubGlobal('fetch', respond(200, 'not json'));
    await expect(getTransaction('k', '1')).rejects.toMatchObject({ kind: 'transient' });
  });
});
