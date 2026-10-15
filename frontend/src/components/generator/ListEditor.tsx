import { useRef, useState } from 'react';
import type { ListDef, Row } from '@/types/generator';
import { Button, inputClass } from '@/components/ui';
import { importTable } from '@/utils/tableImport';
import { FieldInput } from '@/components/generator/FieldInputs';

/**
 * A table of rows (line items, stops, status events). Rows can be typed, pasted from Excel, or loaded
 * from a CSV file. Columns for product ids the partner does not use are hidden, so an order for a
 * retailer that wants UPC and vendor number shows exactly those.
 */
export default function ListEditor({ def, rows, onChange, itemIds }: { def: ListDef; rows: Row[]; onChange: (r: Row[]) => void; itemIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const columns = def.columns.filter((c) => !c.qualifier || itemIds.includes(c.qualifier));
  const blank = (): Row => Object.fromEntries(def.columns.map((c) => [c.key, c.type === 'select' ? c.options?.[0]?.value ?? '' : '']));

  const apply = (source: string, mode: 'replace' | 'append') => {
    const r = importTable(source, columns, def.max);
    setStatus({ ok: r.ok, message: r.message });
    if (!r.ok) return;
    // Imported rows start from a full blank row so every column has a value (selects get their default)
    const imported = r.rows.map((row) => ({ ...blank(), ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== '')) }));
    onChange(mode === 'replace' ? imported : [...rows, ...imported].slice(0, def.max));
    setText('');
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (/\.xlsx?$/i.test(file.name)) {
      setStatus({ ok: false, message: 'Excel files are not read directly. In Excel, select the rows and paste them below, or save the sheet as CSV.' });
      return;
    }
    apply(await file.text(), 'replace');
    if (fileRef.current) fileRef.current.value = '';
  };

  const update = (i: number, key: string, value: string) => onChange(rows.map((r, k) => (k === i ? { ...r, [key]: value } : r)));

  return (
    <div className="col-span-full">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-700">
          {def.label} <span className="font-normal text-gray-400">({rows.length})</span>
        </h3>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => setOpen((o) => !o)}>{open ? 'Close import' : 'Paste / import'}</Button>
          <Button type="button" size="sm" variant="secondary" disabled={rows.length >= def.max} onClick={() => onChange([...rows, blank()])}>+ {def.addLabel}</Button>
        </div>
      </div>

      {open && (
        <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
          <p className="mb-2 text-xs text-blue-900">
            Copy rows from Excel and paste them here (include the header row if you have one), or choose a CSV file. Columns are matched by name: Quantity, UPC, Price, Description and so on.
          </p>
          <textarea aria-label="Pasted rows" value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={'Quantity\tUPC\tPrice\n5\t012345678905\t12.46'} className={`${inputClass} w-full font-mono text-xs`} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={!text.trim()} onClick={() => apply(text, 'replace')}>Replace lines</Button>
            <Button type="button" size="sm" variant="secondary" disabled={!text.trim()} onClick={() => apply(text, 'append')}>Add to lines</Button>
            <label className="cursor-pointer rounded-lg px-3 py-1 text-sm font-medium text-blue-700 ring-1 ring-inset ring-blue-300 hover:bg-blue-100">
              Choose CSV file
              <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,.xlsx,.xls" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
            </label>
          </div>
          {status && <p className={`mt-2 text-xs ${status.ok ? 'text-green-700' : 'text-red-700'}`} role="status">{status.message}</p>}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            <tr>
              <th className="w-8 px-2 py-2">#</th>
              {columns.map((c) => <th key={c.key} className="px-1 py-2">{c.label}{c.required && <span className="text-red-500"> *</span>}</th>)}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="px-2 py-1 text-center text-xs tabular-nums text-gray-400">{i + 1}</td>
                {columns.map((c) => (
                  <td key={c.key} className="px-0.5 py-0.5">
                    <FieldInput cell def={{ ...c, label: `${def.label} ${i + 1} ${c.label}` }} value={r[c.key] ?? ''} onChange={(v) => update(i, c.key, String(v))} />
                  </td>
                ))}
                <td className="px-1 text-center">
                  <button
                    type="button"
                    aria-label={`Remove row ${i + 1}`}
                    disabled={rows.length <= def.min}
                    onClick={() => onChange(rows.filter((_, k) => k !== i))}
                    className="rounded px-1.5 text-base leading-none text-gray-300 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={columns.length + 2} className="px-3 py-4 text-center text-xs text-gray-400">No rows yet. Add one, or paste from Excel.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
