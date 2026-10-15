import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '@/services/api';
import { useActiveTenantId } from '@/stores/authStore';
import type { ChatStatus, ChatTurn, Proposal } from '@/types/chat';
import { Button } from '@/components/ui';
import { renderChatText } from '@/utils/chatText';

const STARTERS = [
  'Did we receive PO 100 from one of our partners?',
  'Which documents are still waiting for a 997?',
  'Show failed documents from the last 7 days',
  'Create a rule to notify me when a 997 is missing for 24 hours',
];

/** Not shown: tells the model what really happened after a card was confirmed */
const DONE_MARK = '(Done:';

type Settled = NonNullable<ChatTurn['settled']>[string];

/** Runs a confirmed card through the portal's normal API: same validation, roles, limits and audit as the screens. */
async function execute(tenantId: number, p: Proposal): Promise<Exclude<Settled, 'cancelled'>> {
  const d = p.payload;
  switch (p.kind) {
    case 'create_997_rule':
      await api.saveAckRule(tenantId, null, d as any);
      return { ok: true, text: 'The reminder rule is created.', link: { to: '/partners', label: 'See it on the Partners page' } };
    case 'create_ticket': {
      const r = await api.createTicket(tenantId, d as any);
      return { ok: true, text: `Ticket ${r.key} created.`, link: { to: `/tickets/${r.id}`, label: `Open ${r.key}` } };
    }
    case 'send_report': {
      const r = await api.emailReport(tenantId, d as any);
      return r.failed.length ? { ok: false, text: `Sent to ${r.sent}. Not delivered to: ${r.failed.map((f) => f.to).join(', ')}.` } : { ok: true, text: `The report was sent to ${d.to.join(', ')}.` };
    }
    case 'comment_ticket':
      await api.commentOnTicket(tenantId, d.ticketId, d.body);
      return { ok: true, text: 'The comment is posted.', link: { to: `/tickets/${d.ticketId}`, label: 'Open the ticket' } };
  }
}

function Card({ p, state, onConfirm, onCancel, busy }: { p: Proposal; state?: Settled; onConfirm: () => void; onCancel: () => void; busy: boolean }) {
  return (
    <div className="mt-2 rounded-lg border border-blue-200 bg-white p-3 text-sm shadow-sm" data-testid="proposal">
      <p className="font-semibold text-gray-900">{p.title}</p>
      <dl className="mt-1.5 space-y-0.5">
        {p.details.map(([k, v]) => (
          <div key={k} className="flex gap-2"><dt className="w-28 shrink-0 text-xs text-gray-500">{k}</dt><dd className="min-w-0 break-words text-gray-800">{v}</dd></div>
        ))}
      </dl>
      {!state && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" isLoading={busy} onClick={onConfirm}>Confirm</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
        </div>
      )}
      {state === 'cancelled' && <p className="mt-2 text-xs text-gray-500">Cancelled. Nothing was done.</p>}
      {state && state !== 'cancelled' && (
        <p className={`mt-2 text-xs ${state.ok ? 'text-green-700' : 'text-red-700'}`} role="status">
          {state.text}{' '}
          {state.link && <Link to={state.link.to} className="font-medium underline">{state.link.label}</Link>}
        </p>
      )}
    </div>
  );
}

/** The assistant: a button on every page that opens a chat about this organisation's EDI traffic. */
export default function ChatWidget() {
  const tenantId = useActiveTenantId();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  // A different organisation is a different conversation
  useEffect(() => { setTurns([]); setStatus(null); }, [tenantId]);

  useEffect(() => {
    if (!open || !tenantId) return;
    api.chatStatus(tenantId).then(setStatus).catch(() => setStatus(null));
  }, [open, tenantId]);

  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [turns, busy]);

  useEffect(() => {
    if (!busy) { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(t);
  }, [busy]);

  if (!tenantId) return null;

  const unavailable = status && !status.enabled ? 'The assistant is switched off for this organisation.'
    : status && !status.configured ? `The assistant is not set up yet. An administrator needs to save the ${status.provider ?? 'AI provider'} API key on the tenant settings page.`
    : null;

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const next: ChatTurn[] = [...turns, { role: 'user', text: q }];
    setTurns(next);
    setInput('');
    setBusy(true);
    try {
      const r = await api.chat(tenantId, next.map((t) => ({ role: t.role, text: t.text })));
      setTurns([...next, { role: 'assistant', text: r.reply, proposals: r.proposals }]);
      api.chatStatus(tenantId).then(setStatus).catch(() => undefined);
    } catch (e) {
      setTurns([...next, { role: 'assistant', text: errorMessage(e, 'Something went wrong. Please try again.'), error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const settle = (turnIndex: number, id: string, s: Settled) =>
    setTurns((ts) => ts.map((t, i) => (i === turnIndex ? { ...t, settled: { ...t.settled, [id]: s } } : t)));

  const confirm = async (turnIndex: number, p: Proposal) => {
    setActing(p.id);
    try {
      const s = await execute(tenantId, p);
      settle(turnIndex, p.id, s);
      // Tell the model what really happened so a follow-up question is answered correctly
      setTurns((ts) => [...ts, { role: 'assistant', text: `${DONE_MARK} ${s.text})` }]);
    } catch (e) {
      settle(turnIndex, p.id, { ok: false, text: errorMessage(e, 'That did not go through.') });
    } finally {
      setActing(null);
    }
  };

  const submit = (e: FormEvent) => { e.preventDefault(); void send(input); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} aria-label="Open the assistant"
        className="fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg ring-4 ring-blue-600/20 transition hover:scale-105 hover:bg-blue-700">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" /><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" strokeWidth="2.4" /></svg>
      </button>
    );
  }

  return (
    <section role="dialog" aria-label="Assistant" className="fixed bottom-5 right-5 z-40 flex h-[36rem] max-h-[85vh] w-[26rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-gray-200">
      <header className="flex items-center justify-between bg-slate-900 px-4 py-3 text-white">
        <div>
          <p className="text-sm font-semibold">EDI Assistant</p>
          <p className="text-[11px] text-slate-400">Ask about documents, 997s, tickets and rules</p>
        </div>
        <div className="flex items-center gap-1">
          {turns.length > 0 && <button type="button" onClick={() => setTurns([])} className="rounded px-2 py-1 text-xs text-slate-300 hover:bg-white/10">New chat</button>}
          <button type="button" onClick={() => setOpen(false)} aria-label="Close the assistant" className="rounded px-2 py-1 text-lg leading-none text-slate-300 hover:bg-white/10">×</button>
        </div>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto bg-gray-50 px-3 py-3 text-sm">
        {turns.length === 0 && (
          <div>
            <p className="text-gray-700">Hi! Ask me about your EDI traffic. I only answer from your portal data, and I will ask when I need a detail, like which partner or order number.</p>
            <div className="mt-3 flex flex-col gap-1.5">
              {STARTERS.map((s) => <button key={s} type="button" disabled={!!unavailable} onClick={() => setInput(s)} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-left text-xs text-gray-700 hover:border-blue-300 hover:bg-blue-50 disabled:opacity-50">{s}</button>)}
            </div>
          </div>
        )}
        {turns.map((t, i) => (t.text.startsWith(DONE_MARK) ? null : (
          <div key={i} className={t.role === 'user' ? 'flex justify-end' : ''}>
            <div className={`max-w-[92%] rounded-2xl px-3 py-2 ${t.role === 'user' ? 'bg-blue-600 text-white' : t.error ? 'bg-red-50 text-red-800 ring-1 ring-red-200' : 'bg-white text-gray-800 ring-1 ring-gray-200'}`}>
              {t.role === 'user' ? <p className="whitespace-pre-wrap break-words">{t.text}</p> : <div className="break-words">{renderChatText(t.text)}</div>}
              {t.proposals?.map((p) => (
                <Card key={p.id} p={p} state={t.settled?.[p.id]} busy={acting === p.id} onConfirm={() => confirm(i, p)} onCancel={() => settle(i, p.id, 'cancelled')} />
              ))}
            </div>
          </div>
        )))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-gray-500" role="status">
            <span className="flex gap-1" aria-hidden><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" /><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:.15s]" /><i className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:.3s]" /></span>
            {slow ? 'Still working. This is taking longer than usual…' : 'Looking into it…'}
          </div>
        )}
        {unavailable && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{unavailable}</p>}
        <div ref={end} />
      </div>

      <form onSubmit={submit} className="border-t border-gray-200 bg-white p-2">
        <div className="flex items-end gap-2">
          <textarea aria-label="Message" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} rows={1} maxLength={2000} disabled={!!unavailable}
            placeholder={unavailable ? 'Not available' : 'Ask a question…'} className="max-h-28 min-h-[2.5rem] flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100" />
          <Button type="submit" size="sm" isLoading={busy} disabled={!input.trim() || !!unavailable}>Send</Button>
        </div>
        <p className="mt-1 px-1 text-[10px] text-gray-400">Answers come from your portal data and can be wrong; check the linked documents.{status ? ` ${status.usedToday}/${status.dailyLimit} messages used today.` : ''}</p>
      </form>
    </section>
  );
}
