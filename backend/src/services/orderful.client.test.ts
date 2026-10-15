import { describe, it, expect, vi, afterEach } from 'vitest';
import { convertToX12, OrderfulError, backoffMinutes, MAX_ATTEMPTS } from './orderful.client.js';

const ISA = 'ISA*00*          *00*          *02*RBTW           *ZZ*UNITEDTECHNO   *260223*2018*U*00401*000000002*0*T*>~GS*SM~SE*25*0001~GE*1*2~IEA*1*000000002~';

const respond = (status: number, body: unknown, statusText = '') =>
  vi.fn().mockResolvedValue(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, statusText }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('convertToX12', () => {
  it('sends the request Postman sends, and unwraps the JSON array of X12', async () => {
    const fetchMock = respond(201, [ISA]);
    vi.stubGlobal('fetch', fetchMock);

    const edi = await convertToX12('key-123', { transactionSets: [{}] });

    expect(edi).toBe(ISA);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.orderful.com/v3/convert');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Accept: 'application/edi-x12',
      'Content-Type': 'application/json',
      'orderful-api-key': 'key-123',
    });
    expect(JSON.parse(init.body)).toEqual({ transactionSets: [{}] });
  });

  it('joins multiple interchanges with a newline', async () => {
    vi.stubGlobal('fetch', respond(201, [ISA, ISA]));
    expect(await convertToX12('k', {})).toBe(`${ISA}\n${ISA}`);
  });

  it('accepts a bare text/X12 response too', async () => {
    vi.stubGlobal('fetch', respond(200, ISA));
    expect(await convertToX12('k', {})).toBe(ISA);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [400, 'invalid'],
    [422, 'invalid'],
    [429, 'transient'],
    [500, 'transient'],
    [503, 'transient'],
  ])('classifies HTTP %i as %s', async (status, kind) => {
    vi.stubGlobal('fetch', respond(status, { message: 'nope' }));
    await expect(convertToX12('k', {})).rejects.toMatchObject({ kind, status });
  });

  it('classifies a network failure as transient', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(convertToX12('k', {})).rejects.toMatchObject({ kind: 'transient' });
  });

  it('rejects a 2xx that is not EDI', async () => {
    vi.stubGlobal('fetch', respond(201, ['<html>oops</html>']));
    await expect(convertToX12('k', {})).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('never puts the message body or key in an error', async () => {
    vi.stubGlobal('fetch', respond(422, { message: 'bad segment' }));
    const err = (await convertToX12('super-secret-key', { po: 'CUSTOMER-ORDER-DATA' }).catch((e) => e)) as OrderfulError;
    expect(err.message).toContain('bad segment');
    expect(err.message).not.toContain('super-secret-key');
    expect(err.message).not.toContain('CUSTOMER-ORDER-DATA');
  });
});

describe('backoff', () => {
  it('waits 2, 15, 60 minutes then gives up', () => {
    expect([1, 2, 3, 4].map(backoffMinutes)).toEqual([2, 15, 60, null]);
    expect(MAX_ATTEMPTS).toBe(4);
  });
});
