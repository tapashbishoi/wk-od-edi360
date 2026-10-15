import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import { useActiveTenantId, useAuthStore } from '@/stores/authStore';
import type { PartnerRow } from '@/types/flow';
import { Button, Card, EmptyState, ErrorNote, PageHeader } from '@/components/ui';
import Spinner from '@/components/Spinner';
import AckRulesSection from '@/pages/AckRulesPage';
import ManageFlowModal from '@/components/flow/ManageFlowModal';
import TrackFlowModal from '@/components/flow/TrackFlowModal';
import { useTenantTimezone } from '@/stores/authStore';

/** Trading partners seen in traffic: which 997s to track, and the document flow expected with each. */
export default function PartnersPage() {
  const tenantId = useActiveTenantId();
  const role = useAuthStore((s) => s.user?.role);
  const tz = useTenantTimezone();
  const editable = role === 'platform_admin' || role === 'customer_admin' || role === 'support';
  const [partners, setPartners] = useState<PartnerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState<PartnerRow | null>(null);
  const [tracking, setTracking] = useState(false);

  const load = () => {
    if (!tenantId) return;
    api.partners(tenantId).then(setPartners).catch((e) => setError(errorMessage(e, 'Could not load partners')));
  };
  useEffect(load, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (p: PartnerRow, key: 'track_inbound_ack' | 'expect_outbound_ack') => {
    if (!tenantId) return;
    const next = !p[key];
    setPartners((list) => list && list.map((x) => (x.partner_id === p.partner_id ? { ...x, [key]: next } : x)));
    try {
      await api.savePartnerSettings(tenantId, p.partner_id, key === 'track_inbound_ack' ? { trackInboundAck: next } : { expectOutboundAck: next });
    } catch (e) {
      setError(errorMessage(e, 'Could not save'));
      load();
    }
  };

  if (!tenantId) return <EmptyState title="No tenant selected" />;

  return (
    <>
      <PageHeader
        title="Trading partners"
        subtitle="Partners appear here once their documents arrive. Set which acknowledgments to track and the document sequence expected with each."
        actions={<Button onClick={() => setTracking(true)} disabled={!partners?.length}>🔎 Track Document Flow</Button>}
      />
      {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}
      {partners === null && !error && <Spinner />}
      {partners && partners.length === 0 && <EmptyState title="No partners yet">Partners show up as soon as their first document is ingested.</EmptyState>}
      {partners && partners.length > 0 && (
        <Card title="Trading Partners & 997 Acknowledgments">
          <p className="mb-3 text-sm text-gray-500">Not every partner implements 997. Turn outbound tracking on only for partners who send one back, otherwise their documents would sit at "Awaiting 997" forever.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2">Partner</th>
                  <th className="px-3 py-2">Documents</th>
                  <th className="px-3 py-2">Inbound: show the 997 we send</th>
                  <th className="px-3 py-2">Outbound: expect a 997 back</th>
                  <th className="px-3 py-2">EDI flow</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {partners.map((p) => (
                  <tr key={p.partner_id}>
                    <td className="px-3 py-3"><p className="font-medium text-gray-900">{p.name ?? p.partner_id}</p><p className="font-mono text-xs text-gray-400">{p.partner_id}</p></td>
                    <td className="px-3 py-3 text-gray-700">{p.documents}</td>
                    <td className="px-3 py-3">
                      <label className="flex items-center gap-2"><input type="checkbox" disabled={!editable} checked={p.track_inbound_ack} onChange={() => toggle(p, 'track_inbound_ack')} aria-label={`Track inbound 997 for ${p.partner_id}`} />{p.track_inbound_ack ? 'Tracked' : 'Not tracked'}</label>
                    </td>
                    <td className="px-3 py-3">
                      <label className="flex items-center gap-2"><input type="checkbox" disabled={!editable} checked={p.expect_outbound_ack} onChange={() => toggle(p, 'expect_outbound_ack')} aria-label={`Expect outbound 997 for ${p.partner_id}`} />{p.expect_outbound_ack ? 'Expected' : 'Not expected'}</label>
                    </td>
                    <td className="px-3 py-3">
                      <Button size="sm" onClick={() => setManaging(p)}>⇄ {editable ? 'Manage EDI Flow' : 'View EDI Flow'}{p.flows > 0 ? ` (${p.flows})` : ''}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {partners && partners.length > 0 && (role === 'platform_admin' || role === 'customer_admin' || role === 'support') && <AckRulesSection tenantId={tenantId} partners={partners} />}
      {managing && <ManageFlowModal tenantId={tenantId} partner={managing} editable={editable} onClose={() => setManaging(null)} onChanged={load} />}
      {tracking && partners && <TrackFlowModal tenantId={tenantId} partners={partners} tz={tz} onClose={() => setTracking(false)} />}
    </>
  );
}
