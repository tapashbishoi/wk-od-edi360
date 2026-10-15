import { Router, type Request, type Response } from 'express';
import { query, queryOne, transaction } from '../db/connection.js';
import { authMiddleware, requireActiveTenant, requireTenantMember } from '../middleware/auth.middleware.js';
import { audit } from '../services/audit.service.js';
import { DOCS, GROUP_ORDER, describeDoc, getDoc } from '../generator/registry.js';
import { PRESETS, PartnerError, defaultPartner, normalizePartner } from '../generator/partner.js';
import { GeneratorError, generate, sampleValues } from '../generator/generate.js';
import { profileFromEdi } from '../generator/fromTraffic.js';
import { readRawEdi } from '../services/rawEdi.service.js';
import { PARTNER_ID_SQL } from '../utils/savedView.js';
import type { PartnerProfile } from '../generator/types.js';

/**
 * /api/tenants/:tenantId/generator - build test EDI files for a trading partner.
 *
 * For the people who set up and test integrations (platform admin, customer admin, support), not
 * for business or auditor roles. A preview has no side effects; only /generate takes the partner's
 * next control numbers and records the file.
 */
const router = Router({ mergeParams: true });
router.use(authMiddleware, requireActiveTenant, requireTenantMember);

function requireGeneratorAccess(req: Request, res: Response, next: () => void) {
  if (!['platform_admin', 'customer_admin', 'support'].includes(req.user?.role ?? '')) return res.status(403).json({ error: 'Forbidden' });
  next();
}
router.use(requireGeneratorAccess);

const tenantIdOf = (req: Request) => Number(req.params.tenantId);

/** Wraps a handler so a generator/partner error becomes a 400 with its message, not a 500. */
const friendly = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof PartnerError || error instanceof GeneratorError) return res.status(400).json({ error: error.message });
    throw error;
  }
};

interface PartnerRow {
  id: number;
  name: string;
  code: string;
  profile: PartnerProfile;
  isa_control_next: string;
  gs_control_next: string;
}

const loadPartner = (tenantId: number, id: number) =>
  queryOne<PartnerRow>(`SELECT id, name, code, profile, isa_control_next, gs_control_next FROM wk_trading_partners WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);

/**
 * The profile a request is about. A saved partner (scoped to this tenant) supplies the control-number
 * counters; the profile itself comes from the request when it carries one, so edits that have not been
 * saved yet still show in the preview, and from the saved copy otherwise. With no saved partner, the
 * profile typed into the form is used as is.
 */
async function resolvePartner(req: Request): Promise<{ profile: PartnerProfile; row: PartnerRow | null }> {
  const id = req.body?.partnerId;
  if (id !== undefined && id !== null && id !== '') {
    const row = await loadPartner(tenantIdOf(req), Number(id));
    if (!row) throw new PartnerError('That trading partner was not found');
    return { profile: normalizePartner(req.body?.partner ?? row.profile), row };
  }
  return { profile: normalizePartner(req.body?.partner), row: null };
}

const senderOf = (v: unknown, fallback: 'partner' | 'us'): 'partner' | 'us' => (v === 'partner' || v === 'us' ? v : fallback);

// ---------------------------------------------------------------- reference data

router.get('/doc-types', (_req, res) => {
  res.json({ groups: GROUP_ORDER, docs: DOCS.map(describeDoc) });
});

router.get('/presets', (_req, res) => {
  res.json({ presets: PRESETS.map((p) => ({ key: p.key, label: p.label, description: p.description, partner: p.build() })) });
});

/**
 * The tenant's real trading partners (seen in traffic), each with a profile read from the envelope of
 * its latest converted document, so a test file can be built for them without typing their ids in.
 * Falls back to the ids in the Orderful message when nothing has been converted yet.
 */
router.get('/traffic-partners', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const { rows } = await query(
    `SELECT DISTINCT ON (pid) pid, pname, direction, raw_edi, sender_isa_id, receiver_isa_id,
            (SELECT COALESCE(ARRAY_AGG(DISTINCT x.document_type) FILTER (WHERE x.document_type IS NOT NULL), '{}')
               FROM wk_transactions x WHERE x.tenant_id = $1 AND (CASE x.direction WHEN 'inbound' THEN x.sender_id ELSE x.receiver_id END) = pid) AS types
       FROM (SELECT ${PARTNER_ID_SQL} AS pid, CASE t.direction WHEN 'inbound' THEN t.sender_name ELSE t.receiver_name END AS pname,
                    t.direction, t.last_activity_at, m.raw_edi, m.sender_isa_id, m.receiver_isa_id
               FROM wk_transactions t LEFT JOIN wk_orderful_messages m ON m.transaction_id = t.id
              WHERE t.tenant_id = $1 AND t.direction IN ('inbound','outbound')) s
      WHERE pid IS NOT NULL
      ORDER BY pid, (raw_edi IS NOT NULL) DESC, last_activity_at DESC NULLS LAST`,
    [tenantId]
  );

  const partners = rows.map((r: any) => {
    const name = r.pname || r.pid;
    const partnerSent = r.direction === 'inbound';
    let profile: PartnerProfile | null = null;
    if (r.raw_edi) {
      try {
        profile = profileFromEdi(readRawEdi(r.raw_edi), name, partnerSent);
      } catch {
        /* stored under an old key: fall back to the ids */
      }
    }
    const fromEnvelope = !!profile;
    if (!profile) {
      profile = defaultPartner(name);
      profile.name = name;
      profile.code = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || 'PARTNER';
      const theirs = partnerSent ? r.sender_isa_id : r.receiver_isa_id;
      const ours = partnerSent ? r.receiver_isa_id : r.sender_isa_id;
      if (theirs) profile.theirs = { ...profile.theirs, isaId: String(theirs).slice(0, 15), gsId: String(theirs).slice(0, 15) };
      if (ours) profile.ours = { ...profile.ours, isaId: String(ours).slice(0, 15), gsId: String(ours).slice(0, 15) };
    }
    return { partnerId: r.pid, name, types: r.types, fromEnvelope, profile };
  });
  res.json({ partners });
});

// ---------------------------------------------------------------- partners

router.get('/partners', async (req, res) => {
  const { rows } = await query<PartnerRow & { updated_at: string }>(
    `SELECT id, name, code, profile, isa_control_next, gs_control_next, updated_at FROM wk_trading_partners WHERE tenant_id = $1 ORDER BY lower(name)`,
    [tenantIdOf(req)]
  );
  res.json({
    partners: rows.map((r) => ({ id: r.id, name: r.name, code: r.code, profile: r.profile, isaControlNext: Number(r.isa_control_next), gsControlNext: Number(r.gs_control_next), updatedAt: r.updated_at })),
  });
});

router.post('/partners', friendly(async (req, res) => {
  const profile = normalizePartner(req.body?.partner);
  const tenantId = tenantIdOf(req);
  try {
    const row = await queryOne<{ id: number }>(
      `INSERT INTO wk_trading_partners (tenant_id, name, code, profile, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tenantId, profile.name, profile.code, JSON.stringify(profile), req.user!.userId]
    );
    await audit(req, { action: 'generator.partner.create', tenantId, target: profile.name });
    res.status(201).json({ id: row!.id, partner: profile });
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ error: 'A trading partner with that name already exists' });
    throw error;
  }
}));

router.put('/partners/:id', friendly(async (req, res) => {
  const profile = normalizePartner(req.body?.partner);
  const tenantId = tenantIdOf(req);
  try {
    // Counters are only touched when explicitly set, so editing a profile never rewinds the control numbers
    const isa = req.body?.isaControlNext;
    const row = await queryOne<{ id: number }>(
      `UPDATE wk_trading_partners SET name = $3, code = $4, profile = $5,
              isa_control_next = COALESCE($6::bigint, isa_control_next)
        WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [Number(req.params.id), tenantId, profile.name, profile.code, JSON.stringify(profile), Number.isInteger(isa) && isa >= 1 && isa <= 999999999 ? isa : null]
    );
    if (!row) return res.status(404).json({ error: 'Trading partner not found' });
    await audit(req, { action: 'generator.partner.update', tenantId, target: profile.name });
    res.json({ id: row.id, partner: profile });
  } catch (error: any) {
    if (error.code === '23505') return res.status(409).json({ error: 'A trading partner with that name already exists' });
    throw error;
  }
}));

router.delete('/partners/:id', async (req, res) => {
  const tenantId = tenantIdOf(req);
  const row = await queryOne<{ name: string }>(`DELETE FROM wk_trading_partners WHERE id = $1 AND tenant_id = $2 RETURNING name`, [Number(req.params.id), tenantId]);
  if (!row) return res.status(404).json({ error: 'Trading partner not found' });
  await audit(req, { action: 'generator.partner.delete', tenantId, target: row.name });
  res.status(204).end();
});

// ---------------------------------------------------------------- building files

/** A starting form for a document: the partner's defaults plus sample data. */
router.post('/defaults', friendly(async (req, res) => {
  const def = getDoc(String(req.body?.docType));
  if (!def) return res.status(400).json({ error: 'Unknown document type' });
  const { profile } = await resolvePartner(req);
  const sender = senderOf(req.body?.sender, def.defaultSender);
  res.json({ sender, values: sampleValues(def.code, profile, sender) });
}));

/**
 * The control numbers a file would use. For a saved partner it is that partner's next numbers (so the
 * preview matches what /generate will write); otherwise whatever was typed, or 1.
 */
function previewControl(row: PartnerRow | null, body: any) {
  if (body?.control && typeof body.control === 'object') {
    // Passed through as sent: an impossible number (0, 1e12, "abc") must be refused by the generator, not quietly replaced by a default
    const n = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    const c = body.control;
    return { isa: n(c.isa), gs: n(c.gs), st: typeof c.st === 'string' ? c.st : undefined };
  }
  return row ? { isa: Number(row.isa_control_next), gs: Number(row.gs_control_next) } : {};
}

router.post('/preview', friendly(async (req, res) => {
  const def = getDoc(String(req.body?.docType));
  if (!def) return res.status(400).json({ error: 'Unknown document type' });
  const { profile, row } = await resolvePartner(req);
  const sender = senderOf(req.body?.sender, def.defaultSender);
  const result = generate({ docType: def.code, partner: profile, sender, values: req.body?.values ?? sampleValues(def.code, profile, sender), control: previewControl(row, req.body) });
  res.json(result);
}));

/**
 * Builds the file for real. For a saved partner it takes that partner's next ISA and GS control
 * numbers (unless the caller supplies them), atomically, so two people generating at once never
 * produce files with the same number. The file and its numbers are recorded in the history.
 */
router.post('/generate', friendly(async (req, res) => {
  const def = getDoc(String(req.body?.docType));
  if (!def) return res.status(400).json({ error: 'Unknown document type' });
  const tenantId = tenantIdOf(req);
  const { profile, row } = await resolvePartner(req);
  const sender = senderOf(req.body?.sender, def.defaultSender);
  const manual = req.body?.control && typeof req.body.control === 'object';

  const result = await transaction(async (client) => {
    let control = previewControl(null, req.body);
    if (row && !manual) {
      // Take the next numbers and advance the counters in one statement; wrap 999999999 back to 1
      const taken = await client.query(
        `UPDATE wk_trading_partners
            SET isa_control_next = CASE WHEN isa_control_next >= 999999999 THEN 1 ELSE isa_control_next + 1 END,
                gs_control_next  = CASE WHEN gs_control_next  >= 999999999 THEN 1 ELSE gs_control_next + 1 END
          WHERE id = $1 AND tenant_id = $2
        RETURNING isa_control_next, gs_control_next`,
        [row.id, tenantId]
      );
      const t = taken.rows[0];
      // RETURNING gives the value AFTER the increment; the number used is the one before it
      const before = (n: string) => (Number(n) === 1 ? 999999999 : Number(n) - 1);
      control = { isa: before(t.isa_control_next), gs: before(t.gs_control_next), st: undefined };
    }

    // With no values sent (a script, not the form) the document starts from the partner's sample, not from empty
    const file = generate({ docType: def.code, partner: profile, sender, values: req.body?.values ?? sampleValues(def.code, profile, sender), control });
    const saved = await client.query(
      `INSERT INTO wk_generated_files (tenant_id, partner_id, partner_name, doc_type, sender, filename, content, isa_control, gs_control, segments, warnings, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [tenantId, row?.id ?? null, profile.name, def.code, sender, file.filename, file.text, file.control.isa, file.control.gs, file.stats.segments, file.warnings.length, req.user!.userId]
    );
    return { ...file, historyId: saved.rows[0].id as number };
  });

  await audit(req, { action: 'generator.file', tenantId, target: result.filename, details: { docType: def.code, partner: profile.name } });
  res.status(201).json(result);
}));

// ---------------------------------------------------------------- history

router.get('/history', async (req, res) => {
  const { rows } = await query(
    `SELECT id, partner_name, doc_type, sender, filename, isa_control, gs_control, segments, warnings, created_at
       FROM wk_generated_files WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
    [tenantIdOf(req)]
  );
  res.json({ files: rows });
});

router.get('/history/:id/download', async (req, res) => {
  const row = await queryOne<{ filename: string; content: string }>(`SELECT filename, content FROM wk_generated_files WHERE id = $1 AND tenant_id = $2`, [Number(req.params.id), tenantIdOf(req)]);
  if (!row) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  // The name was built from sanitised parts, but is still quoted defensively
  res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/[^\w.-]/g, '_')}"`);
  res.send(row.content);
});

export default router;
