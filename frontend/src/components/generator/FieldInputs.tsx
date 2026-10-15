import type { ChangeEvent } from 'react';
import type { FieldDef, Party, Value } from '@/types/generator';
import { inputClass } from '@/components/ui';

/**
 * The inputs the document forms are drawn from. A document is described by a schema (see
 * backend/src/generator), so adding a document type means adding a schema, not a screen.
 */

export const emptyParty = (): Party => ({ name: '', idQual: '92', id: '', address: '', address2: '', city: '', state: '', zip: '', country: 'US' });

const ID_QUALIFIERS = [
  ['92', '92 · assigned by buyer'], ['91', '91 · assigned by seller'], ['93', '93 · assigned by originator'], ['UL', 'UL · GLN'], ['1', '1 · DUNS'], ['9', '9 · DUNS+4'],
];

function Labelled({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`block text-xs font-medium text-gray-500 ${wide ? 'col-span-2' : ''}`}>
      {label}
      {children}
    </label>
  );
}

export function PartyInput({ value, onChange, label }: { value: Party; onChange: (p: Party) => void; label: string }) {
  const set = (k: keyof Party) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange({ ...value, [k]: e.target.value });
  const small = `${inputClass} mt-1 w-full`;
  return (
    <fieldset className="col-span-full rounded-lg border border-gray-200 p-3">
      <legend className="px-1 text-xs font-semibold text-gray-600">{label}</legend>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <Labelled label="Name" wide><input aria-label={`${label} name`} value={value.name} onChange={set('name')} maxLength={60} className={small} /></Labelled>
        <Labelled label="ID type">
          <select aria-label={`${label} id type`} value={value.idQual} onChange={set('idQual')} className={small}>
            {ID_QUALIFIERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Labelled>
        <Labelled label="ID" wide><input aria-label={`${label} id`} value={value.id} onChange={set('id')} maxLength={80} className={`${small} font-mono`} /></Labelled>
        <Labelled label="Address" wide><input aria-label={`${label} address`} value={value.address} onChange={set('address')} maxLength={55} className={small} /></Labelled>
        <Labelled label="Address 2" wide><input aria-label={`${label} address 2`} value={value.address2} onChange={set('address2')} maxLength={55} className={small} /></Labelled>
        <Labelled label="City" wide><input aria-label={`${label} city`} value={value.city} onChange={set('city')} maxLength={30} className={small} /></Labelled>
        <Labelled label="State"><input aria-label={`${label} state`} value={value.state} onChange={set('state')} maxLength={2} className={small} /></Labelled>
        <Labelled label="ZIP"><input aria-label={`${label} zip`} value={value.zip} onChange={set('zip')} maxLength={15} className={`${small} font-mono`} /></Labelled>
        <Labelled label="Country"><input aria-label={`${label} country`} value={value.country} onChange={set('country')} maxLength={3} className={small} /></Labelled>
      </div>
    </fieldset>
  );
}

function asString(v: Value | undefined): string {
  return typeof v === 'string' ? v : '';
}

interface FieldInputProps {
  def: FieldDef;
  value: Value | undefined;
  onChange: (v: Value) => void;
  /** Smaller, label-less, for table cells */
  cell?: boolean;
}

export function FieldInput({ def, value, onChange, cell = false }: FieldInputProps) {
  const base = cell ? 'w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-xs hover:bg-gray-100 focus:border-blue-500 focus:bg-white focus:outline-none' : `${inputClass} mt-1 w-full`;
  const cls = `${base} ${def.mono ? 'font-mono' : ''}`;
  const label = def.label;

  if (def.type === 'party') return <PartyInput label={label} value={(value as Party) ?? emptyParty()} onChange={onChange} />;

  let control: React.ReactNode;
  if (def.type === 'checkbox') {
    return (
      <label className="col-span-full flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    );
  } else if (def.type === 'select') {
    control = (
      <select aria-label={label} value={asString(value)} onChange={(e) => onChange(e.target.value)} className={cls}>
        {def.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else if (def.type === 'textarea') {
    control = <textarea aria-label={label} value={asString(value)} onChange={(e) => onChange(e.target.value)} rows={3} maxLength={def.maxLength} className={cls} />;
  } else {
    const type = def.type === 'date' ? 'date' : def.type === 'time' ? 'time' : 'text';
    control = (
      <input
        aria-label={label}
        type={type}
        inputMode={def.type === 'number' ? 'decimal' : undefined}
        value={asString(value)}
        onChange={(e) => onChange(e.target.value)}
        placeholder={def.placeholder}
        className={cls}
      />
    );
  }

  if (cell) return control;
  return (
    <label className="block text-xs font-medium text-gray-500" title={def.help}>
      <span>
        {label}
        {def.required && <span className="text-red-500"> *</span>}
        {def.ref && <span className="ml-1 font-mono text-[10px] font-normal text-gray-400">{def.ref}</span>}
      </span>
      {control}
      {def.help && <span className="mt-0.5 block text-[11px] font-normal text-gray-400">{def.help}</span>}
    </label>
  );
}
