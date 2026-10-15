import { useState } from 'react';
import { api, errorMessage } from '@/services/api';
import { Button, Card, ErrorNote, PageHeader } from '@/components/ui';

const CHAPTERS = [
  'What EDI360 does',
  'Roles and what each can do',
  'Signing in and finding your way around',
  'The Dashboard',
  'Documents: search, filter and export',
  'A single document in detail',
  'Understanding statuses and 997s',
  'Partners and expected EDI flows',
  '997 reminder rules',
  'Email alerts',
  'Tickets in Jira or ServiceNow',
  'Emailing a document report',
  'The AI assistant and Explain EDI',
  'Workato recipes',
  'Test file generator',
  'Settings for administrators',
  'Onboarding and testing a new trading partner',
  'Cookbook: step-by-step recipes',
  'For platform administrators',
  'Reference: document types and terms',
];

/** The user guide, behind sign-in: fetched with the user's session, then opened or saved from memory. */
export default function HelpPage() {
  const [busy, setBusy] = useState<'open' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchGuide = async () => URL.createObjectURL(new Blob([await api.userGuide()], { type: 'application/pdf' }));

  const open = async () => {
    setBusy('open');
    setError(null);
    // The tab is opened first, while the click still counts, then pointed at the guide
    const tab = window.open('', '_blank');
    try {
      const url = await fetchGuide();
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (e) {
      tab?.close();
      setError(errorMessage(e, 'Could not open the guide'));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const a = document.createElement('a');
      a.href = await fetchGuide();
      a.download = 'EDI360-User-Guide.pdf';
      a.click();
    } catch (e) {
      setError(errorMessage(e, 'Could not download the guide'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Help" subtitle="How to use EDI360, from finding a document to onboarding a trading partner." />
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="EDI360 user guide and cookbook" className="lg:col-span-1">
          <p className="mb-4 text-sm text-gray-600">
            A complete guide to every screen, with step-by-step recipes for everyday support work and for testing a new trading partner. It opens as a PDF you can read, search and print.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={open} isLoading={busy === 'open'}>Open the guide</Button>
            <Button variant="secondary" onClick={save} isLoading={busy === 'save'}>Download PDF</Button>
          </div>
        </Card>
        <Card title="What is inside" className="lg:col-span-2">
          <ol className="grid list-decimal gap-x-8 gap-y-1 pl-5 text-sm text-gray-700 sm:grid-cols-2" data-testid="chapters">
            {CHAPTERS.map((c) => <li key={c}>{c}</li>)}
          </ol>
        </Card>
      </div>
    </>
  );
}
