import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import TransactionLanes from './TransactionLanes';
import type { Lane } from '@/types';

const stage = (type: Lane['type'], canonical_status: any) => ({
  execution_id: 1, stage_type: type, canonical_status, source_status: null, started_at: null, ended_at: null,
});

const orderful: Lane = {
  type: 'orderful', label: 'Orderful', stage: stage('orderful', 'Delivered'),
  data: {
    orderful_transaction_id: '861041851', type_name: '850_PURCHASE_ORDER', document_type: '850', business_number: 'PO5776275333276666',
    sender_isa_id: 'ODFLRETAILTEST', sender_name: 'Retail Integration Testing', receiver_isa_id: 'UNITEDTECHNO', receiver_name: 'United Techno Demo',
    stream: 'TEST', validation_status: 'VALID', acknowledgment_status: 'ACCEPTED', delivery_status: 'SENT', delivery_id: 'd1',
    isa_control_number: '000000010', gs_control_number: '000000010', st_control_number: '0001',
    orderful_created_at: null, orderful_updated_at: null, raw_edi_status: 'pending',
  },
};

const workato: Lane = {
  type: 'workato', label: 'Workato', stage: stage('workato', 'Warning'),
  data: {
    recipeId: '82858874', recipeName: 'Orderful EDI 850 to XML', jobId: 'j-AbrBGNTG-mGCtRa-CD', durationMs: 2000,
    jobUrl: 'https://app.workato.com/recipes/82858874/job/j-Abr9NLed-poPHTr-CD',
    failure: { stage: 'orderful_ack', step: 6, message: 'delivery status is DELIVERED' },
    steps: [
      { n: 0, kind: 'orderful', adapter: 'orderful', operation: 'new_transactions_from_poller_bucket', ok: true },
      { n: 3, kind: 'logic', adapter: 'js_eval', operation: 'invoke_custom_js_code', ok: true },
      { n: 6, kind: 'orderful', adapter: 'orderful', operation: 'approve_delivery', ok: false, error: '400 already DELIVERED' },
    ],
  },
};

const erp: Lane = {
  type: 'erp', label: 'Target (ERP)', stage: stage('erp', 'Sent to ERP'),
  data: { role: 'destination', system: 'Workato file storage', operation: 'store_file', ok: true, stepNumber: 4, detail: { path: '/EDI/Inbound/EDI850_861041851.xml', size: 3116 } },
};

const positions = () => screen.getAllByTestId(/^lane-/).map((el) => el.getAttribute('data-testid'));

describe('TransactionLanes', () => {
  it('draws Orderful, Workato, Target left to right for an inbound transaction', () => {
    render(<TransactionLanes lanes={[orderful, workato, erp]} direction="inbound" />);
    expect(positions()).toEqual(['lane-orderful', 'lane-workato', 'lane-erp']);
    expect(screen.getByRole('list', { name: 'Transaction flow' })).toHaveAttribute('data-direction', 'inbound');
  });

  it('draws Source (ERP), Workato, Orderful for an outbound transaction', () => {
    const outErp: Lane = { ...erp, label: 'Source (ERP)', data: { ...(erp.data as any), role: 'origin' } };
    render(<TransactionLanes lanes={[outErp, workato, orderful]} direction="outbound" />);
    expect(positions()).toEqual(['lane-erp', 'lane-workato', 'lane-orderful']);
    expect(screen.getByRole('region', { name: 'Source (ERP)' })).toBeInTheDocument();
  });

  it('labels the blocks Source, Processing, Destination by position', () => {
    render(<TransactionLanes lanes={[orderful, workato, erp]} direction="inbound" />);
    expect(screen.getByTestId('lane-orderful')).toHaveTextContent('1 · Source');
    expect(screen.getByTestId('lane-workato')).toHaveTextContent('2 · Processing');
    expect(screen.getByTestId('lane-erp')).toHaveTextContent('3 · Destination');
  });

  it('shows each block its own status', () => {
    render(<TransactionLanes lanes={[orderful, workato, erp]} direction="inbound" />);
    expect(within(screen.getByTestId('lane-orderful')).getByText('Delivered')).toBeInTheDocument();
    expect(within(screen.getByTestId('lane-workato')).getByText('Warning')).toBeInTheDocument();
    expect(within(screen.getByTestId('lane-erp')).getByText('Sent to ERP')).toBeInTheDocument();
  });

  it('shows the Orderful identifiers and the stored file', () => {
    render(<TransactionLanes lanes={[orderful, workato, erp]} direction="inbound" />);
    const o = screen.getByTestId('lane-orderful');
    expect(within(o).getByText('861041851')).toBeInTheDocument();
    expect(within(o).getByText('000000010 / 000000010 / 0001')).toBeInTheDocument();
    expect(within(screen.getByTestId('lane-erp')).getByText('/EDI/Inbound/EDI850_861041851.xml')).toBeInTheDocument();
  });

  it('marks the step that failed, with its error, and explains the failure stage', () => {
    render(<TransactionLanes lanes={[orderful, workato, erp]} direction="inbound" />);
    const failed = screen.getByTestId('step-6');
    expect(failed).toHaveAttribute('data-failed', 'true');
    expect(failed).toHaveTextContent('FAILED HERE');
    expect(failed).toHaveTextContent('400 already DELIVERED');
    expect(screen.getByTestId('step-3')).not.toHaveAttribute('data-failed');
    expect(screen.getByRole('alert')).toHaveTextContent('Failed at: Orderful approve / acknowledge');
  });

  it('says so when a block was not observed, instead of showing a made-up state', () => {
    render(<TransactionLanes lanes={[orderful, workato, { type: 'erp', label: 'Target (ERP)', stage: stage('erp', 'Unknown'), data: null }]} direction="inbound" />);
    const notObserved = within(screen.getByTestId('lane-erp')).getByTestId('not-observed');
    expect(notObserved).toHaveTextContent('state is not known');
    expect(within(screen.getByTestId('lane-erp')).getByText('Unknown')).toBeInTheDocument();
  });

  it('explains an Orderful block that failed before anything was created', () => {
    render(<TransactionLanes lanes={[erp, workato, { type: 'orderful', label: 'Orderful', stage: stage('orderful', 'Failed'), data: null }]} direction="outbound" />);
    expect(within(screen.getByTestId('lane-orderful')).getByTestId('not-observed')).toHaveTextContent('send failed before a transaction existed');
  });

  it('only links to https job URLs', () => {
    const bad: Lane = { ...workato, data: { ...(workato.data as any), jobUrl: 'javascript:alert(1)' } };
    render(<TransactionLanes lanes={[orderful, bad, erp]} direction="inbound" />);
    expect(screen.queryByRole('link', { name: /open job/i })).toBeNull();
  });

  it('links to the Workato job when the URL is https', () => {
    render(<TransactionLanes lanes={[orderful, workato, erp]} direction="inbound" />);
    const link = screen.getByRole('link', { name: /open job/i });
    expect(link).toHaveAttribute('href', 'https://app.workato.com/recipes/82858874/job/j-Abr9NLed-poPHTr-CD');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
