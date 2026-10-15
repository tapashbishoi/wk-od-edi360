import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { query, queryOne, closePool } from './connection.js';
import { normalizeEvent } from '../services/normalization.service.js';
import { extractAndStore } from '../services/businessDetails.service.js';
import { encryptSecret } from '../utils/crypto.js';
import { dedupKey, parseJobUrl } from '../utils/workatoJob.js';
import { buildDemoX12, SITES, UT_WAREHOUSE, type DemoDocType } from './demoX12.js';

/**
 * Sample data: a tenant called "Sample data (demo)" holding ~50 jobs over the last 14 days, built
 * from the real sample log with ids, dates and partners varied. It covers every shape the UI has to
 * draw (clean inbound, the sample's Warning, failures before and at the target, outbound, a running
 * job) and the full 850 -> 855 -> 856 -> 810 flow for several purchase orders, each with business
 * details and raw EDI, so the business cards, flow views and raw EDI viewer have something to show.
 *
 *   npm run db:seed-demo              create (safe to re-run; existing jobs are kept)
 *   npm run db:seed-demo -- --remove  delete the sample tenant and everything under it
 *
 * This tenant has its OWN slug, and --remove refuses to delete a tenant with that slug unless it is
 * the one this script made, so it can never touch a real tenant. Rows are written straight into the
 * database and normalized, so no broker, API key or Orderful account is needed.
 */

const SLUG = 'sample_data';
const NAME = 'Sample data (demo)';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '../test/fixtures/inbound-850-approve-failed.json');

// Deterministic, so a re-run produces the same ids and doesn't pile up duplicates
let seed = 20261007;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

type Kind = 'ok' | 'warn' | 'failTransform' | 'failTarget' | 'running';
const INBOUND_KINDS: [Kind, number][] = [['ok', 22], ['warn', 6], ['failTransform', 4], ['failTarget', 3], ['running', 1]];
const inboundKinds = INBOUND_KINDS.flatMap(([k, n]) => Array(n).fill(k) as Kind[]);

const iso = (d: Date) => d.toISOString();
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

interface Plan {
  index: number;
  start: Date;
  kind: Kind | 'outbound';
  po: string;
  docType: DemoDocType;
  buyerIdx: number;
  /** For outbound documents: the 850 they respond to */
  failed?: boolean;
}

const poFor = (i: number) => `PO${5776000000 + i * 37}`;

function inbound(base: any, plan: Plan) {
  const i = plan.index;
  const site = SITES[plan.buyerIdx];
  const txt = JSON.stringify(base)
    .replaceAll('861041851', String(861100000 + i))
    .replaceAll('861044669', String(861200000 + i))
    .replaceAll('PO5776275333276666', plan.po)
    .replaceAll('j-AbrBGNTG-mGCtRa-CD', `j-DEMO${String(i).padStart(3, '0')}-child-CD`)
    .replaceAll('j-Abr9NLed-poPHTr-CD', `j-DEMO${String(i).padStart(3, '0')}-parent-CD`)
    .replaceAll('Retail Integration Testing', site.name)
    .replaceAll('006ae0f0-3f8b-453a-a0bf-713543e78e27', crypto.randomUUID());
  const job = JSON.parse(txt);

  job.started_at = iso(plan.start);
  job.completed_at = iso(new Date(plan.start.getTime() + 1500 + Math.floor(rnd() * 4000)));
  job.account_name = 'Demo';

  const clearError = () => {
    delete job.lines[6]?.error;
    delete job.error;
  };

  if (plan.kind === 'ok') {
    clearError();
    job.status = 'succeeded';
  } else if (plan.kind === 'failTransform') {
    job.lines = job.lines.slice(0, 4);
    job.lines[3].error = "TypeError: Cannot read properties of undefined (reading 'PO1_loop')";
    job.lines[3].output = {};
    job.error = JSON.stringify({ message: job.lines[3].error, inner_message: null });
  } else if (plan.kind === 'failTarget') {
    job.lines = job.lines.slice(0, 5);
    job.lines[4].error = '403 Forbidden: storage quota exceeded for path /EDI/Inbound';
    job.lines[4].output = {};
    job.error = JSON.stringify({ message: job.lines[4].error, inner_message: null });
  } else if (plan.kind === 'running') {
    clearError();
    job.status = 'pending';
    job.completed_at = null;
    job.lines = job.lines.slice(0, 3);
  }
  // 'warn' keeps the sample as it is
  return job;
}

const DOC_NAMES: Record<DemoDocType, string> = {
  '850': '850_PURCHASE_ORDER',
  '855': '855_PURCHASE_ORDER_ACKNOWLEDGMENT',
  '856': '856_SHIP_NOTICE_MANIFEST',
  '810': '810_INVOICE',
};

function outbound(base: any, plan: Plan) {
  const i = plan.index;
  const inb = JSON.parse(JSON.stringify(base));
  const tx = inb.lines[0].output.transactions[0];
  const partner = SITES[plan.buyerIdx].name;
  const conn = 'orderful_connector_1897324_1774864874';
  const sap = 'sap_s4hana_1897324_1790000000';
  const failed = !!plan.failed;
  const typeName = DOC_NAMES[plan.docType];

  const createInput = { sender: tx.receiver, receiver: tx.sender, type: { name: typeName }, stream: 'TEST', message: inb.lines[2].output.transaction_message };
  const created = {
    id: String(862000000 + i), businessNumber: plan.po, type: { name: typeName }, stream: 'TEST', validationStatus: 'VALID',
    deliveryStatus: failed ? 'FAILED' : 'DELIVERED', acknowledgmentStatus: failed ? 'REJECTED' : 'ACCEPTED',
    sender: { ...tx.receiver, name: 'United Techno Demo' }, receiver: { ...tx.sender, name: partner },
    createdAt: iso(plan.start), lastUpdatedAt: iso(new Date(plan.start.getTime() + 4000)),
  };

  const id = `j-DEMOOUT${String(i).padStart(3, '0')}-CD`;
  return {
    id,
    master_job_id: `j-DEMOOUT${String(i).padStart(3, '0')}-M-CD`,
    recipe_id: 82858999,
    title: `Outbound ${plan.docType} to Orderful for ${plan.po}`,
    status: failed ? 'failed' : 'succeeded',
    is_test: true,
    started_at: iso(plan.start),
    completed_at: iso(new Date(plan.start.getTime() + 4000)),
    account_id: 1897324,
    environment_type: 'dev',
    error: failed ? JSON.stringify({ message: '422 Unprocessable: missing required segment', inner_message: null }) : null,
    report: { custom_column_0: plan.po, custom_column_1: partner },
    context: { recipe_name: `SAP ${plan.docType} to Orderful`, recipe_path: 'Home/EDI/Outbound', recipe_id: 82858999 },
    job_url: `https://app.workato.com/recipes/82858999/job/${id}`,
    lines: [
      { adapter_name: sap, adapter_operation: 'get_idoc', recipe_line_number: 0, input: {}, output: { docnum: `00000${i}` } },
      { adapter_name: 'js_eval', adapter_operation: 'invoke_custom_js_code', recipe_line_number: 1, input: {}, output: {} },
      failed
        ? { adapter_name: conn, adapter_operation: 'create_record', recipe_line_number: 2, input: createInput, output: {}, error: '422 Unprocessable: missing required segment' }
        : { adapter_name: conn, adapter_operation: 'create_record', recipe_line_number: 2, input: createInput, output: created },
    ],
  };
}

/** The plan for every job: inbound 850s first, then 855/856/810 responses tied to their POs. */
function makePlans(now: number): Plan[] {
  const plans: Plan[] = [];
  const inboundStarts: Date[] = [];

  inboundKinds.forEach((kind, i) => {
    // Spread over 12 days, weighted toward recent, leaving room for the responses that follow
    const start = new Date(now - Math.floor(rnd() ** 1.6 * 12 * 86400000) - 3 * 86400000 - 120000);
    inboundStarts.push(start);
    plans.push({ index: i, start, kind, po: poFor(i), docType: '850', buyerIdx: i % SITES.length });
  });

  // Responses for the clean inbound POs: 855 an hour later, 856 a day later, 810 two days later.
  // Every fifth response fails, so the flow view has broken links to show.
  const clean = plans.filter((p) => p.kind === 'ok' || p.kind === 'warn').slice(0, 5);
  const offsets: [DemoDocType, number][] = [['855', 3600000], ['856', 86400000], ['810', 2 * 86400000]];
  let n = inboundKinds.length;
  clean.forEach((parent, k) => {
    // The last PO stops after its 856: the invoice is "missing"
    const docs = k === clean.length - 1 ? offsets.slice(0, 2) : offsets;
    docs.forEach(([docType, offset]) => {
      const start = new Date(parent.start.getTime() + offset);
      if (start.getTime() > now) return;
      plans.push({ index: n, start, kind: 'outbound', po: parent.po, docType, buyerIdx: parent.buyerIdx, failed: n % 5 === 0 });
      n++;
    });
  });
  return plans;
}

async function remove() {
  const t = await queryOne<{ id: number; name: string }>(`SELECT id, name FROM wk_tenants WHERE slug = $1`, [SLUG]);
  if (!t) return console.log('No sample-data tenant to remove.');
  // Belt and braces: the slug is reserved for this script, but never delete one that isn't ours
  if (t.name !== NAME) {
    console.log(`A tenant with slug "${SLUG}" exists but is named "${t.name}", not "${NAME}", so it was NOT created by this script. Nothing removed.`);
    process.exitCode = 1;
    return;
  }
  await query(`DELETE FROM wk_audit_logs WHERE tenant_id = $1`, [t.id]);
  await query(`DELETE FROM wk_users WHERE tenant_id = $1`, [t.id]);
  await query(`DELETE FROM wk_tenants WHERE id = $1`, [t.id]);
  console.log('Removed the sample-data tenant and all of its data.');
}

async function create() {
  const base = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

  let tenant = await queryOne<{ id: number; name: string }>(`SELECT id, name FROM wk_tenants WHERE slug = $1`, [SLUG]);
  if (tenant && tenant.name !== NAME) {
    console.log(`A tenant with slug "${SLUG}" exists but was not created by this script ("${tenant.name}"). Nothing changed.`);
    process.exitCode = 1;
    return;
  }
  if (!tenant) {
    tenant = (await queryOne<{ id: number; name: string }>(
      // raw_edi_enabled shows the raw EDI panel; the seeded messages are already converted, so nothing is sent to Orderful
      `INSERT INTO wk_tenants (slug, name, status, timezone, workato_account_id, queue_name, dlq_name, raw_edi_enabled)
       VALUES ($1, $2, 'active', 'America/Los_Angeles', '1897324', $3, $4, true) RETURNING id, name`,
      [SLUG, NAME, `workato_${SLUG}`, `workato_${SLUG}.dlq`]
    ))!;
  }
  const tenantId = tenant.id;

  const now = Date.now();
  const plans = makePlans(now);
  let created = 0;

  for (const plan of plans) {
    const job = plan.kind === 'outbound' ? outbound(base, plan) : inbound(base, plan);

    const { parentJobId } = parseJobUrl(job.job_url);
    const row = await queryOne<{ id: number }>(
      `INSERT INTO wk_source_events
         (tenant_id, event_id, schema_version, source_mode, dedup_key, workato_account_id, recipe_id, job_id,
          master_job_id, parent_job_id, source_status, started_at, completed_at, received_at, raw_job)
       VALUES ($1,$2,1,'push',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (tenant_id, dedup_key) DO NOTHING RETURNING id`,
      [
        tenantId, crypto.randomUUID(), dedupKey(job), String(job.account_id), String(job.recipe_id), job.id,
        job.master_job_id ?? null, parentJobId, job.status, job.started_at, job.completed_at ?? null, job.started_at,
        JSON.stringify(job),
      ]
    );
    if (!row) continue;
    await normalizeEvent(row.id);
    created++;

    // Attach the converted X12 and its business details, as the raw-EDI worker would after /v3/convert
    const ex = await queryOne<{ transaction_id: number; document_type: string | null }>(
      `SELECT e.transaction_id, t.document_type FROM wk_executions e JOIN wk_transactions t ON t.id = e.transaction_id WHERE e.source_event_id = $1`,
      [row.id]
    );
    const hasMessage = ex && (await queryOne(`SELECT 1 FROM wk_orderful_messages WHERE transaction_id = $1`, [ex.transaction_id]));
    if (ex && hasMessage && ['850', '855', '856', '810'].includes(ex.document_type ?? '')) {
      const site = SITES[plan.buyerIdx];
      const x12 = buildDemoX12({
        docType: ex.document_type as DemoDocType,
        po: plan.po,
        date: ymd(plan.start),
        senderId: plan.kind === 'outbound' ? 'UNITEDTECHNO' : 'ACMERETAIL',
        receiverId: plan.kind === 'outbound' ? 'ACMERETAIL' : 'UNITEDTECHNO',
        buyer: site,
        shipTo: SITES[(plan.buyerIdx + 1) % SITES.length],
        shipFrom: UT_WAREHOUSE,
        vendor: UT_WAREHOUSE,
        seq: plan.index,
      });
      await query(
        `UPDATE wk_orderful_messages SET raw_edi = $2, raw_edi_status = 'converted', raw_edi_converted_at = NOW() WHERE transaction_id = $1`,
        [ex.transaction_id, encryptSecret(x12)]
      );
      await extractAndStore(tenantId, ex.transaction_id, x12, ex.document_type);
    }
  }

  console.log(`Sample-data tenant ready (id ${tenantId}). Added ${created} job(s); ${plans.length - created} already existed.`);
}

(process.argv.includes('--remove') ? remove() : create())
  .catch((error) => {
    console.error('Failed:', error.message);
    process.exitCode = 1;
  })
  .finally(closePool);
