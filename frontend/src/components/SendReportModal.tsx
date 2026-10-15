import { FormEvent, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import type { PickedDoc } from '@/types/actions';
import { Button, ErrorNote, inputClass } from '@/components/ui';
import Modal from '@/components/flow/Modal';

const docName = (d: PickedDoc) => `${d.type ?? 'EDI'} ${d.number ?? `#${d.id}`}`;
const EMAIL = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;

/** Splits "a@x.com, b@y.com; c@z.com" into addresses. */
export const parseRecipients = (text: string): string[] => [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];

export function defaultSubject(docs: PickedDoc[]): string {
  return docs.length === 1 ? `EDI ${docName(docs[0])}: ${docs[0].status}` : `EDI report: ${docs.length} documents`;
}

/**
 * Email someone a report on the selected documents: a business section and a technical section, built by
 * the server. Not an alert subscription: this tells a person about documents that already exist.
 */
export default function SendReportModal({ tenantId, docs, onClose }: { tenantId: number; docs: PickedDoc[]; onClose: () => void }) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState(defaultSubject(docs));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const recipients = parseRecipients(to);
  const bad = recipients.find((a) => !EMAIL.test(a));
  const valid = recipients.length >= 1 && recipients.length <= 5 && !bad && subject.trim().length >= 3;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.emailReport(tenantId, { transactionIds: docs.map((d) => d.id), to: recipients, subject: subject.trim(), note: note.trim() || undefined });
      setDone(r.failed.length ? `Sent to ${r.sent}. Not delivered to: ${r.failed.map((f) => f.to).join(', ')}.` : `Report sent to ${recipients.join(', ')}.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not send the report'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Send email" subtitle={docs.length === 1 ? docName(docs[0]) : `${docs.length} documents in one report`} onClose={onClose}>
      {done ? (
        <div className="rounded-lg bg-green-50 p-4 text-sm text-green-900" role="status">
          <p className="font-semibold">{done}</p>
          <div className="mt-4"><Button variant="secondary" onClick={onClose}>Close</Button></div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm font-medium text-gray-700">
            To
            <input aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@company.com (up to 5, separated by commas)" autoComplete="off" className={`${inputClass} mt-1 w-full`} />
            {bad && <span className="mt-1 block text-xs text-red-600">"{bad}" is not a valid email address.</span>}
            {recipients.length > 5 && <span className="mt-1 block text-xs text-red-600">At most 5 recipients.</span>}
          </label>

          <label className="block text-sm font-medium text-gray-700">
            Subject
            <input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={150} className={`${inputClass} mt-1 w-full`} />
          </label>

          <label className="block text-sm font-medium text-gray-700">
            Message <span className="font-normal text-gray-400">(optional, shown at the top)</span>
            <textarea aria-label="Message" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} placeholder="Why you are sending this, what you would like them to do." className={`${inputClass} mt-1 w-full`} />
          </label>

          <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            They receive a report with a business summary (document, partners, ship from and to, amounts, references, line items), where it stands in Orderful, Workato and the ERP, and a technical section (identifiers, failed steps, links). Replies come to you. Raw EDI is never included.
          </p>

          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex gap-2 border-t border-gray-200 pt-4">
            <Button type="submit" isLoading={busy} disabled={!valid}>Send report</Button>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
