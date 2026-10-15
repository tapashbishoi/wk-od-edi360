import { useState } from 'react';
import { api, errorMessage } from '@/services/api';
import type { RawEdiResponse } from '@/types';
import { Button, Card, ErrorNote } from '@/components/ui';
import { splitSegments } from '@/utils/status';

/**
 * Raw EDI for one transaction. Fetched only when asked for - it is customer
 * payload data, every view is audited server-side, and most visits never need it.
 */
export default function RawEdiPanel({ tenantId, transactionId, enabled }: { tenantId: number; transactionId: number; enabled: boolean }) {
  const [data, setData] = useState<RawEdiResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await api.rawEdi(tenantId, transactionId));
    } catch (e) {
      setError(errorMessage(e, 'Could not load raw EDI'));
    } finally {
      setBusy(false);
    }
  };

  const convert = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.convertRawEdi(tenantId, transactionId);
      if (r.result === 'converted' || r.result === 'skipped') await load();
      else setError(r.error ?? `Conversion ${r.result}`);
    } catch (e) {
      setError(errorMessage(e, 'Conversion failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Raw EDI" actions={!data && enabled && <Button size="sm" variant="secondary" onClick={load} isLoading={busy}>Show raw EDI</Button>}>
      {!enabled && <p className="text-sm text-gray-500">Raw EDI conversion is not enabled for this tenant.</p>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {data?.rawEdi ? (
        <>
          <pre className="max-h-96 overflow-auto rounded bg-gray-900 p-4 font-mono text-xs leading-5 text-green-100" data-testid="raw-edi">
            {splitSegments(data.rawEdi).join('\n')}
          </pre>
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(data.rawEdi!).catch(() => {})}>Copy</Button>
          </div>
        </>
      ) : (
        data && (
          <div className="space-y-2 text-sm text-gray-600">
            <p>
              {data.status === 'pending' && 'Not converted yet. The background job will pick it up shortly, or convert it now.'}
              {data.status === 'failed' && `Conversion failed${data.error ? `: ${data.error}` : '.'}`}
              {data.status === 'unavailable' && 'No message was found in the job logs, so there is nothing to convert.'}
            </p>
            {(data.status === 'pending' || data.status === 'failed') && <Button size="sm" onClick={convert} isLoading={busy}>Convert now</Button>}
          </div>
        )
      )}
    </Card>
  );
}
