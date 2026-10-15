import { useRef, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import { Button, Card, ErrorNote, inputClass } from '@/components/ui';

const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch', 'Chinese', 'Japanese', 'Korean', 'Hindi', 'Arabic'];

/**
 * Explain EDI: the document's EDI in plain language, for people who do not read X12. Asked for on
 * demand (the EDI goes to the tenant's Gemini account, and each ask costs them), cached per
 * language. The text is shown in a script-less sandboxed frame: it is generated, so it is never
 * trusted to run anything on this page.
 */
export default function ExplainPanel({ tenantId, transactionId, enabled }: { tenantId: number; transactionId: number; enabled: boolean }) {
  const [language, setLanguage] = useState('English');
  const [html, setHtml] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ cached: boolean; at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  const explain = async (refresh = false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.explainEdi(tenantId, transactionId, language, refresh);
      setHtml(r.html);
      setMeta({ cached: r.cached, at: r.createdAt });
    } catch (e) {
      setError(errorMessage(e, 'Could not explain this document'));
    } finally {
      setBusy(false);
    }
  };

  const print = () => {
    // Same-origin without scripts: the parent can print the frame, the content still cannot run anything
    frame.current?.contentWindow?.focus();
    frame.current?.contentWindow?.print();
  };

  return (
    <Card
      title="Explain EDI"
      actions={
        <div className="flex items-center gap-2">
          <select aria-label="Explanation language" value={language} onChange={(e) => { setLanguage(e.target.value); setHtml(null); setMeta(null); }} className={`${inputClass} text-xs`}>
            {LANGUAGES.map((l) => <option key={l}>{l}</option>)}
          </select>
          <Button size="sm" onClick={() => explain(false)} isLoading={busy} disabled={!enabled}>✨ Explain</Button>
        </div>
      }
    >
      {!enabled && <p className="text-sm text-gray-500">Raw EDI conversion is not enabled for this tenant, so there is nothing to explain.</p>}
      {enabled && !html && !error && !busy && <p className="text-sm text-gray-500">Get this document in plain business language. The EDI is sent to your organisation's Gemini account to write it.</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {busy && <p className="text-sm text-gray-500">Writing the explanation… this can take up to a minute.</p>}
      {html && (
        <div>
          <iframe
            ref={frame}
            title="EDI explanation"
            sandbox="allow-same-origin allow-modals"
            srcDoc={`<!doctype html><meta charset="utf-8"><base target="_blank"><body style="margin:12px;font-family:Arial,sans-serif">${html}</body>`}
            className="h-[32rem] w-full rounded border border-gray-200 bg-white"
          />
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <Button size="sm" variant="secondary" onClick={print}>🖨 Print / save as PDF</Button>
            <Button size="sm" variant="secondary" onClick={() => explain(true)} isLoading={busy}>↻ Regenerate</Button>
            {meta && <span>{meta.cached ? 'Saved explanation' : 'Freshly written'} · {new Date(meta.at).toLocaleString()} · AI-written, check against the EDI for anything important</span>}
          </div>
        </div>
      )}
    </Card>
  );
}
