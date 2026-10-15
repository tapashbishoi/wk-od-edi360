import { FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import type { AssistantSettings } from '@/types/chat';
import { Button, Card, inputClass } from '@/components/ui';
import { formatCost, formatTokens } from '@/utils/aiCost';

/** The portal assistant for this organisation: on or off, which AI model answers, and how many messages a day. */
export default function AssistantCard({ tenantId, onChanged }: { tenantId: number; onChanged?: () => void }) {
  const [s, setS] = useState<AssistantSettings | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [limit, setLimit] = useState('');
  const [provider, setProvider] = useState<'gemini' | 'openai' | 'anthropic'>('gemini');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api.assistantSettings(tenantId).then((r) => {
    setS(r);
    setEnabled(r.enabled);
    setLimit(r.dailyLimit === null ? '' : String(r.dailyLimit));
    setProvider(r.provider);
    setModel(r.model ?? '');
  }).catch((e) => setMsg({ ok: false, text: errorMessage(e, 'Could not load the assistant settings') }));
  useEffect(() => { void load(); }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = limit.trim() === '' ? null : Number(limit);
  const valid = (n === null || (Number.isInteger(n) && n >= 10 && n <= 10000)) && /^[A-Za-z0-9._:-]{0,60}$/.test(model.trim());
  const chosen = s?.providers.find((p) => p.id === provider);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.saveAssistantSettings(tenantId, { enabled, dailyLimit: n, provider, model: model.trim() || null });
      await load();
      onChanged?.();
      setMsg({ ok: true, text: enabled ? 'Saved. The assistant is on.' : 'Saved. The assistant is off for this organisation.' });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err, 'Could not save') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="AI model (assistant and Explain EDI)" className="lg:col-span-2">
      <p className="mb-3 text-sm text-gray-600">
        One model choice for both the chat on every page (it answers questions about documents, 997s and tickets, and prepares rules, tickets and emails to confirm) and Explain EDI (plain-language summaries of a document).
        It uses this organisation's own AI account, so every question and every new explanation counts against that key. An explanation is saved, so opening the same document again costs nothing.
      </p>
      <form onSubmit={save} className="space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <input type="checkbox" aria-label="Assistant on" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Assistant is on
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-gray-700">AI model provider
            <select aria-label="AI model provider" value={provider} onChange={(e) => { setProvider(e.target.value as typeof provider); setModel(''); }} className={`${inputClass} mt-1 block w-full`}>
              {(s?.providers ?? []).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium text-gray-700">Model <span className="font-normal text-gray-400">(optional)</span>
            <input aria-label="Model" list="assistant-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={chosen ? `Default: ${chosen.defaultModel}` : ''} className={`${inputClass} mt-1 block w-full`} />
            <datalist id="assistant-models">{(chosen?.models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
          </label>
        </div>
        {chosen && (
          <p className={`rounded-lg p-2 text-xs ${chosen.hasKey ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-900'}`} role="status">
            {chosen.hasKey ? `${chosen.label} API key saved (ends in ${chosen.keyHint ?? '....'}).` : `No ${chosen.label} API key saved yet. Add it under Connections above, then the assistant can use it.`}
          </p>
        )}
        <p className="text-xs text-gray-500">GPT-4o mini and Claude Haiku are the quick, low-cost choices; Claude Sonnet and Gemini Pro are slower but more careful. If answers time out, a different provider often helps.</p>

        <label className="block text-sm font-medium text-gray-700">Messages per day
          <input aria-label="Messages per day" type="number" min={10} max={10000} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder={s ? `Default (${s.defaultLimit})` : ''} className={`${inputClass} mt-1 block w-48`} />
          {!valid && <span className="mt-1 block text-xs text-red-600">Check the daily limit (10 to 10000) and the model name.</span>}
        </label>
        {s && <p className="text-xs text-gray-500">Chat messages today: {s.usedToday} of {s.dailyLimit ?? s.defaultLimit}. The count resets at midnight UTC.</p>}
        {s && (
          <p className="rounded-lg bg-gray-50 p-2 text-xs text-gray-700" data-testid="usage30d">
            Last 30 days: {s.usage30d.chat.requests} chat question{s.usage30d.chat.requests === 1 ? '' : 's'} and {s.usage30d.explain.requests} explained document{s.usage30d.explain.requests === 1 ? '' : 's'}, {formatTokens(s.usage30d.chat.inputTokens + s.usage30d.explain.inputTokens)} tokens in and {formatTokens(s.usage30d.chat.outputTokens + s.usage30d.explain.outputTokens)} out, about {formatCost(s.usage30d.chat.unpriced + s.usage30d.explain.unpriced > 0 && s.usage30d.chat.costUsd + s.usage30d.explain.costUsd === 0 ? null : s.usage30d.chat.costUsd + s.usage30d.explain.costUsd)}{s.usage30d.chat.unpriced + s.usage30d.explain.unpriced > 0 ? ' (some calls are on a model with no price on file)' : ''}.
          </p>
        )}
        {msg && <p className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-700'}`} role="status">{msg.text}</p>}
        <Button type="submit" isLoading={busy} disabled={!valid}>Save</Button>
      </form>
    </Card>
  );
}
