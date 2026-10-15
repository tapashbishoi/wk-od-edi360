import { Router, type Request, type Response } from 'express';
import { query, queryOne } from '../db/connection.js';
import { authMiddleware, requireActiveTenant, requireTenantMember } from '../middleware/auth.middleware.js';
import { audit } from '../services/audit.service.js';
import { PARTNER_ID_SQL } from '../utils/savedView.js';
import { FlowError, evaluateFlow, normalizeFlowName, normalizeSteps, type FlowStep } from '../services/flow.service.js';

/**
 * /api/tenants/:tenantId/partners - trading partners seen in traffic, their 997 switches, the
 * document flows expected with each, and tracking one business document along a flow.
 *
 * A partner is the far end of a transaction (sender when inbound, receiver when outbound), keyed by
 * its ISA id. Anyone in the tenant can read; changing configuration needs an admin or support role.
 */
const router = Router({ mergeParams: true });
router.use(authMiddleware, requireActiveTenant, requireTenantMember);

const tenantIdOf = (req: Request) => Number(req.params.tenantId);

function requireConfigAccess(req: Request, res: Response, next: () => void) {
  if (!['platform_admin', 'customer_admin', 'support'].includes(req.user?.role ?? '')) return res.status(403).json({ error: 'Forbidden' });
  next();
}

const friendly = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof FlowError) return res.status(400).json({ error: error.message });
    throw error;
  }
};

const partnerIdOf = (req: Request) => String(req.params.partnerId ?? '').trim().slice(0, 40);

// The far end of a transaction
const PARTNER_NAME_SQL = `CASE t.direction WHEN 'inbound' THEN t.sender_name ELSE t.receiver_name END`;

router.get('/', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const { rows } = await query(
    `WITH p AS (
       SELECT ${PARTNER_ID_SQL} AS partner_id, ${PARTNER_NAME_SQL} AS partner_name, t.last_activity_at, t.document_type
         FROM wk_transactions t
        WHERE t.tenant_id = $1 AND t.direction IN ('inbound','outbound')
     )
     SELECT p.partner_id, MAX(p.partner_name) AS name, COUNT(*)::int AS documents, MAX(p.last_activity_at) AS last_activity_at,
            COALESCE(ARRAY_AGG(DISTINCT p.document_type) FILTER (WHERE p.document_type IS NOT NULL), '{}') AS types,
            COALESCE(s.track_inbound_ack, TRUE) AS track_inbound_ack,
            COALESCE(s.expect_outbound_ack, TRUE) AS expect_outbound_ack,
            (SELECT COUNT(*)::int FROM wk_partner_flows f WHERE f.tenant_id = $1 AND f.partner_id = p.partner_id) AS flows
       FROM p LEFT JOIN wk_partner_settings s ON s.tenant_id = $1 AND s.partner_id = p.partner_id
      WHERE p.partner_id IS NOT NULL
      GROUP BY p.partner_id, s.track_inbound_ack, s.expect_outbound_ack
      ORDER BY documents DESC, name`,
    [tenantId]
  );
  res.json({ partners: rows });
});

router.put('/:partnerId/settings', requireConfigAccess, async (req, res) => {
  const tenantId = tenantIdOf(req);
  const partnerId = partnerIdOf(req);
  const { trackInboundAck, expectOutboundAck } = req.body ?? {};
  if (typeof trackInboundAck !== 'boolean' && typeof expectOutboundAck !== 'boolean') return res.status(400).json({ error: 'Nothing to change.' });
  const row = await queryOne(
    `INSERT INTO wk_partner_settings (tenant_id, partner_id, track_inbound_ack, expect_outbound_ack)
          VALUES ($1, $2, COALESCE($3, TRUE), COALESCE($4, TRUE))
     ON CONFLICT (tenant_id, partner_id) DO UPDATE SET
          track_inbound_ack = COALESCE($3, wk_partner_settings.track_inbound_ack),
          expect_outbound_ack = COALESCE($4, wk_partner_settings.expect_outbound_ack),
          updated_at = NOW()
      RETURNING track_inbound_ack, expect_outbound_ack`,
    [tenantId, partnerId, typeof trackInboundAck === 'boolean' ? trackInboundAck : null, typeof expectOutboundAck === 'boolean' ? expectOutboundAck : null]
  );
  await audit(req, { action: 'partner.settings', tenantId, target: partnerId });
  res.json(row);
});

router.get('/:partnerId/flows', async (req, res) => {
  const { rows } = await query(`SELECT id, name, steps, updated_at FROM wk_partner_flows WHERE tenant_id = $1 AND partner_id = $2 ORDER BY name`, [tenantIdOf(req), partnerIdOf(req)]);
  res.json({ flows: rows });
});

async function saveFlow(req: Request, res: Response, id: number | null) {
  const tenantId = tenantIdOf(req);
  const partnerId = partnerIdOf(req);
  const name = normalizeFlowName(req.body?.name);
  const steps = normalizeSteps(req.body?.steps);
  const known = await queryOne(`SELECT 1 FROM wk_transactions t WHERE t.tenant_id = $1 AND ${PARTNER_ID_SQL} = $2 LIMIT 1`, [tenantId, partnerId]);
  if (!known) return res.status(404).json({ error: 'Partner not found.' });
  try {
    const row = id === null
      ? await queryOne(`INSERT INTO wk_partner_flows (tenant_id, partner_id, name, steps, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, steps`, [tenantId, partnerId, name, JSON.stringify(steps), req.user?.userId ?? null])
      : await queryOne(`UPDATE wk_partner_flows SET name = $4, steps = $5 WHERE id = $1 AND tenant_id = $2 AND partner_id = $3 RETURNING id, name, steps`, [id, tenantId, partnerId, name, JSON.stringify(steps)]);
    if (!row) return res.status(404).json({ error: 'Flow not found.' });
    await audit(req, { action: id === null ? 'partner.flow.create' : 'partner.flow.update', tenantId, target: `${partnerId}:${name}` });
    return res.status(id === null ? 201 : 200).json(row);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: 'This partner already has a flow with that name.' });
    throw e;
  }
}

router.post('/:partnerId/flows', requireConfigAccess, friendly((req, res) => saveFlow(req, res, null)));
router.put('/:partnerId/flows/:id', requireConfigAccess, friendly((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return Promise.resolve(res.status(400).json({ error: 'Invalid flow id' }));
  return saveFlow(req, res, id);
}));
router.delete('/:partnerId/flows/:id', requireConfigAccess, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid flow id' });
  const r = await query(`DELETE FROM wk_partner_flows WHERE id = $1 AND tenant_id = $2 AND partner_id = $3`, [id, tenantIdOf(req), partnerIdOf(req)]);
  if (!r.rowCount) return res.status(404).json({ error: 'Flow not found.' });
  await audit(req, { action: 'partner.flow.delete', tenantId: tenantIdOf(req), target: String(id) });
  res.status(204).end();
});

const IDENTIFIER_COLUMNS: Record<string, string> = {
  po: 'po_number', shipment: 'shipment_number', invoice: 'invoice_number', bol: 'bol_number', any: 'business_number',
};

/**
 * Follows one business document across a partner's transactions. Starts from the transactions that
 * carry the identifier, then pulls in anything sharing a PO, shipment, invoice or BOL number with
 * them (the 856 that quotes the PO, the 810 that quotes the shipment).
 */
router.post('/track', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const partnerId = String(req.body?.partnerId ?? '').trim().slice(0, 40);
  const type = String(req.body?.identifierType ?? 'any');
  const value = String(req.body?.value ?? '').trim().slice(0, 100);
  const column = IDENTIFIER_COLUMNS[type];
  if (!partnerId || !value) return res.status(400).json({ error: 'Choose a partner and enter an identifier.' });
  if (!column) return res.status(400).json({ error: 'Unknown identifier type.' });

  const cols = `t.id, t.document_type, t.direction, t.canonical_status, t.business_number, t.last_activity_at,
                t.po_number, t.shipment_number, t.invoice_number, t.bol_number,
                (SELECT m.acknowledgment_status FROM wk_orderful_messages m WHERE m.transaction_id = t.id LIMIT 1) AS ack`;
  const ofPartner = `t.tenant_id = $1 AND ${PARTNER_ID_SQL} = $2`;

  const seed = await query(`SELECT ${cols} FROM wk_transactions t WHERE ${ofPartner} AND t.${column} = $3 LIMIT 200`, [tenantId, partnerId, value]);
  const keys = (field: string) => [...new Set(seed.rows.map((r: any) => r[field]).filter(Boolean))];
  const related = seed.rows.length === 0 ? { rows: [] as any[] } : await query(
    `SELECT ${cols} FROM wk_transactions t
      WHERE ${ofPartner} AND (t.po_number = ANY($3) OR t.shipment_number = ANY($4) OR t.invoice_number = ANY($5) OR t.bol_number = ANY($6))
      LIMIT 200`,
    [tenantId, partnerId, keys('po_number'), keys('shipment_number'), keys('invoice_number'), keys('bol_number')]
  );
  const byId = new Map<string, any>();
  for (const r of [...seed.rows, ...related.rows]) byId.set(String(r.id), r);
  const docs = [...byId.values()].sort((a, b) => new Date(a.last_activity_at ?? 0).getTime() - new Date(b.last_activity_at ?? 0).getTime());

  const { rows: flows } = await query(`SELECT id, name, steps FROM wk_partner_flows WHERE tenant_id = $1 AND partner_id = $2 ORDER BY name`, [tenantId, partnerId]);
  const wanted = req.body?.flowId ? flows.find((f: any) => f.id === Number(req.body.flowId)) : undefined;
  // Without a choice, use the first flow that contains one of the documents found
  const flow = wanted ?? flows.find((f: any) => (f.steps as FlowStep[]).some((s) => docs.some((d) => d.document_type === s.docType && d.direction === s.direction))) ?? flows[0];

  const settings = await queryOne<{ expect_outbound_ack: boolean }>(`SELECT expect_outbound_ack FROM wk_partner_settings WHERE tenant_id = $1 AND partner_id = $2`, [tenantId, partnerId]);
  const steps = flow ? evaluateFlow(flow.steps as FlowStep[], docs, { expectOutboundAck: settings?.expect_outbound_ack ?? true }) : [];

  res.json({
    found: docs.length,
    flow: flow ? { id: flow.id, name: flow.name } : null,
    flows: flows.map((f: any) => ({ id: f.id, name: f.name })),
    steps,
    documents: docs.map((d) => ({ id: d.id, type: d.document_type, direction: d.direction, number: d.business_number, status: d.canonical_status, at: d.last_activity_at })),
  });
});

export default router;
