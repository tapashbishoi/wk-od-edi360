import type { ReactNode } from 'react';
import type { Delimiters, IsaParty, Party, PartnerProfile } from '@/types/generator';
import { inputClass } from '@/components/ui';
import { PartyInput } from '@/components/generator/FieldInputs';

/**
 * Everything the generator needs to know about a trading partner: who is on each end of the
 * interchange, which X12 version and delimiters they use, default parties and references, how they
 * identify products, and per-document rules for their quirks.
 */

const ISA_QUALIFIERS: [string, string][] = [
  ['ZZ', 'ZZ · mutually defined'], ['01', '01 · DUNS'], ['02', '02 · SCAC'], ['08', '08 · UCC EDI communications id'], ['12', '12 · phone number'], ['14', '14 · DUNS+4'],
];

const ITEM_ID_CHOICES: [string, string][] = [['UP', 'UPC (UP)'], ['SK', 'SKU (SK)'], ['VP', 'Vendor part (VP)'], ['VN', 'Vendor item (VN)'], ['IN', 'Buyer item (IN)']];

const RULE_HELP = `One rule per line:
AFTER BEG: REF*DP*3        add a segment after the first BEG
REPLACE ITD: ITD**3***Net  swap the generated ITD
REMOVE PER                 drop every PER
# lines starting with # are notes`;

function Group({ title, children, cols = 'grid-cols-2 md:grid-cols-4' }: { title: string; children: ReactNode; cols?: string }) {
  return (
    <section className="rounded-lg border border-gray-200 p-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h4>
      <div className={`grid gap-3 ${cols}`}>{children}</div>
    </section>
  );
}

function L({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`block text-xs font-medium text-gray-500 ${wide ? 'col-span-2' : ''}`}>
      {label}
      {children}
    </label>
  );
}

const field = `${inputClass} mt-1 w-full`;

export default function PartnerEditor({
  profile, onChange, docCode, isaNext, onIsaNext,
}: {
  profile: PartnerProfile;
  onChange: (p: PartnerProfile) => void;
  /** The document being built, so its rules can be edited */
  docCode: string;
  /** Next interchange control number, for a saved partner */
  isaNext?: number | null;
  onIsaNext?: (n: number) => void;
}) {
  const set = <K extends keyof PartnerProfile>(k: K, v: PartnerProfile[K]) => onChange({ ...profile, [k]: v });
  const isa = (side: 'ours' | 'theirs', k: keyof IsaParty, v: string) => onChange({ ...profile, [side]: { ...profile[side], [k]: v } });
  const delim = (k: keyof Delimiters, v: string) => onChange({ ...profile, delimiters: { ...profile.delimiters, [k]: v.slice(-1) } });
  const party = (k: keyof PartnerProfile['parties'], p: Party) => onChange({ ...profile, parties: { ...profile.parties, [k]: p } });
  const def = (k: keyof PartnerProfile['defaults'], v: string) => onChange({ ...profile, defaults: { ...profile.defaults, [k]: v } });

  const toggleItemId = (q: string) => {
    const has = profile.itemIds.includes(q);
    // Keep at least one id; new ones go to the end, which is the order they are written in
    if (has && profile.itemIds.length === 1) return;
    set('itemIds', has ? profile.itemIds.filter((x) => x !== q) : [...profile.itemIds, q]);
  };

  return (
    <div className="space-y-3">
      <Group title="Partner">
        <L label="Name" wide><input aria-label="Partner name" value={profile.name} maxLength={80} onChange={(e) => set('name', e.target.value)} className={field} /></L>
        <L label="Short code (file names)"><input aria-label="Partner code" value={profile.code} maxLength={20} onChange={(e) => set('code', e.target.value)} className={`${field} font-mono`} /></L>
        <L label="Carrier code (SCAC)"><input aria-label="Carrier SCAC" value={profile.scac} maxLength={4} onChange={(e) => set('scac', e.target.value.toUpperCase())} className={`${field} font-mono`} /></L>
      </Group>

      <div className="grid gap-3 md:grid-cols-2">
        {(['ours', 'theirs'] as const).map((side) => (
          <Group key={side} cols="grid-cols-1 sm:grid-cols-3" title={side === 'ours' ? 'Our side of the interchange' : "The partner's side"}>
            <L label="ISA qualifier">
              <select aria-label={`${side} ISA qualifier`} value={profile[side].isaQual} onChange={(e) => isa(side, 'isaQual', e.target.value)} className={field}>
                {ISA_QUALIFIERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </L>
            <L label="ISA id (max 15)"><input aria-label={`${side} ISA id`} value={profile[side].isaId} maxLength={15} onChange={(e) => isa(side, 'isaId', e.target.value)} className={`${field} font-mono`} /></L>
            <L label="GS id"><input aria-label={`${side} GS id`} value={profile[side].gsId} maxLength={15} onChange={(e) => isa(side, 'gsId', e.target.value)} className={`${field} font-mono`} /></L>
          </Group>
        ))}
      </div>

      <Group title="Format">
        <L label="X12 version">
          <select aria-label="X12 version" value={profile.x12Version} onChange={(e) => set('x12Version', e.target.value as PartnerProfile['x12Version'])} className={field}>
            <option value="004010">004010</option>
            <option value="005010">005010</option>
          </select>
        </L>
        <L label="Usage (ISA15)">
          <select aria-label="Usage indicator" value={profile.usage} onChange={(e) => set('usage', e.target.value as 'T' | 'P')} className={field}>
            <option value="T">T · test</option>
            <option value="P">P · production</option>
          </select>
        </L>
        <label className="col-span-2 flex items-end gap-2 pb-2 text-sm text-gray-700">
          <input type="checkbox" checked={profile.ackRequested} onChange={(e) => set('ackRequested', e.target.checked)} />
          Request a 997 acknowledgment (ISA14)
        </label>
        {(['element', 'segment', 'component', 'repetition'] as const).map((k) => (
          <L key={k} label={`${k[0].toUpperCase()}${k.slice(1)} separator`}>
            <input aria-label={`${k} separator`} value={profile.delimiters[k]} onChange={(e) => delim(k, e.target.value)} className={`${field} text-center font-mono`} />
          </L>
        ))}
        {isaNext != null && onIsaNext && (
          <L label="Next interchange control #">
            <input aria-label="Next interchange control number" inputMode="numeric" value={isaNext} onChange={(e) => onIsaNext(Math.min(999999999, Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1)))} className={`${field} font-mono`} />
          </L>
        )}
      </Group>

      <Group title="How this partner identifies products (in the order written)">
        <div className="col-span-full flex flex-wrap items-center gap-4">
          {ITEM_ID_CHOICES.map(([q, label]) => (
            <label key={q} className="flex items-center gap-1.5 text-sm text-gray-700">
              <input type="checkbox" checked={profile.itemIds.includes(q)} onChange={() => toggleItemId(q)} />
              {label}
            </label>
          ))}
          <span className="text-xs text-gray-500">Order: <span className="font-mono">{profile.itemIds.join(' → ')}</span></span>
        </div>
      </Group>

      <Group title="Defaults for new documents">
        <L label="Vendor account"><input aria-label="Default vendor account" value={profile.defaults.vendorAccount} onChange={(e) => def('vendorAccount', e.target.value)} className={field} /></L>
        <L label="Department"><input aria-label="Default department" value={profile.defaults.department} onChange={(e) => def('department', e.target.value)} className={field} /></L>
        <L label="Contact name" wide><input aria-label="Default contact name" value={profile.defaults.contactName} onChange={(e) => def('contactName', e.target.value)} className={field} /></L>
        <L label="Contact phone"><input aria-label="Default contact phone" value={profile.defaults.phone} onChange={(e) => def('phone', e.target.value)} className={field} /></L>
        <L label="Contact email" wide><input aria-label="Default contact email" value={profile.defaults.email} onChange={(e) => def('email', e.target.value)} className={field} /></L>
        <L label="Net days"><input aria-label="Default net days" value={profile.defaults.termsDays} onChange={(e) => def('termsDays', e.target.value)} className={field} /></L>
        <L label="Terms wording" wide><input aria-label="Default terms wording" value={profile.defaults.termsDescription} onChange={(e) => def('termsDescription', e.target.value)} className={field} /></L>
        <L label="Currency">
          <select aria-label="Default currency" value={profile.defaults.currency} onChange={(e) => def('currency', e.target.value)} className={field}>
            {['', 'USD', 'CAD', 'EUR', 'GBP', 'MXN'].map((c) => <option key={c} value={c}>{c || 'None'}</option>)}
          </select>
        </L>
      </Group>

      <div className="grid gap-3">
        <PartyInput label="The partner (buyer, carrier or warehouse)" value={profile.parties.partner} onChange={(p) => party('partner', p)} />
        <PartyInput label="The partner's ship-to (store or DC)" value={profile.parties.partnerShipTo} onChange={(p) => party('partnerShipTo', p)} />
        <PartyInput label="Our company (vendor, shipper, remit-to)" value={profile.parties.ours} onChange={(p) => party('ours', p)} />
        <PartyInput label="Our ship-from (warehouse)" value={profile.parties.oursShipFrom} onChange={(p) => party('oursShipFrom', p)} />
      </div>

      <section className="rounded-lg border border-gray-200 p-3">
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Partner rules for the {docCode}</h4>
        <p className="mb-2 whitespace-pre-line font-mono text-[11px] text-gray-400">{RULE_HELP}</p>
        <textarea
          aria-label={`Rules for ${docCode}`}
          value={profile.docRules[docCode] ?? ''}
          onChange={(e) => onChange({ ...profile, docRules: { ...profile.docRules, [docCode]: e.target.value } })}
          rows={3}
          placeholder="AFTER BEG: REF*DP*3"
          className={`${inputClass} w-full font-mono text-xs`}
        />
      </section>

      <L label="Notes"><textarea aria-label="Partner notes" value={profile.notes} maxLength={1000} onChange={(e) => set('notes', e.target.value)} rows={2} className={field} /></L>
    </div>
  );
}
