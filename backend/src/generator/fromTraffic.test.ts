import { describe, it, expect } from 'vitest';
import { profileFromEdi } from './fromTraffic.js';
import { normalizePartner } from './partner.js';

// The real shape of what Orderful returns for the demo partner's 850
const EDI = [
  'ISA*00*          *00*          *ZZ*ODFLRETAILTEST *02*UNITEDTECHNO   *260223*2018*U*00401*000000002*0*T*>~',
  'GS*PO*ODFLRETAILTEST*UNITEDTECHNO*20260223*2018*2*X*004010UCS~',
  'ST*850*0001~',
  'BEG*00*NE*CHRP12345**20260219~',
  'PO1*1**CA*1.00**VN*12345678*UP*012345678905~',
  'SE*4*0001~',
  'GE*1*2~',
  'IEA*1*000000002~',
].join('');

describe('profileFromEdi', () => {
  it('reads the partner side from the sender of an inbound document', () => {
    const p = profileFromEdi(EDI, 'Retail Integration Testing', true)!;
    expect(p.theirs).toEqual({ isaQual: 'ZZ', isaId: 'ODFLRETAILTEST', gsId: 'ODFLRETAILTEST' });
    expect(p.ours).toEqual({ isaQual: '02', isaId: 'UNITEDTECHNO', gsId: 'UNITEDTECHNO' });
    expect(p.x12Version).toBe('004010');
    expect(p.usage).toBe('T');
    expect(p.delimiters).toMatchObject({ element: '*', segment: '~', component: '>' });
    expect(p.itemIds).toEqual(['VN', 'UP']);
    expect(p.name).toBe('Retail Integration Testing');
    expect(p.code).toBe('RETAILINTEGRATIONTES');
  });

  it('swaps the sides for a document we sent', () => {
    const p = profileFromEdi(EDI, 'Retail', false)!;
    expect(p.theirs.isaId).toBe('UNITEDTECHNO');
    expect(p.ours.isaId).toBe('ODFLRETAILTEST');
  });

  it('produces a profile the generator accepts', () => {
    expect(() => normalizePartner(profileFromEdi(EDI, 'Retail Integration Testing', true))).not.toThrow();
  });

  it('is null for anything that is not an interchange', () => {
    expect(profileFromEdi('not edi', 'x', true)).toBeNull();
    expect(profileFromEdi('ISA*short', 'x', true)).toBeNull();
    expect(profileFromEdi('', 'x', true)).toBeNull();
  });

  it('reads 5010 and production', () => {
    const p = profileFromEdi(EDI.replace('00401', '00501').replace('*T*>~', '*P*>~'), 'x', true)!;
    expect(p.x12Version).toBe('005010');
    expect(p.usage).toBe('P');
  });
});
