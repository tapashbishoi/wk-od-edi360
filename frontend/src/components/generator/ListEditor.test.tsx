import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import ListEditor from './ListEditor';
import type { ListDef, Row } from '@/types/generator';

const DEF: ListDef = {
  key: 'items', label: 'Line items', addLabel: 'Add line', min: 1, max: 5,
  columns: [
    { key: 'qty', label: 'Qty', type: 'number', required: true },
    { key: 'uom', label: 'UOM', type: 'select', options: [{ value: 'EA', label: 'EA' }, { value: 'CA', label: 'CA' }] },
    { key: 'upc', label: 'UPC (UP)', type: 'text', qualifier: 'UP' },
    { key: 'sku', label: 'SKU (SK)', type: 'text', qualifier: 'SK' },
    { key: 'desc', label: 'Description', type: 'text' },
  ],
};

function Harness({ initial = [{ qty: '1', uom: 'EA', upc: '', sku: '', desc: '' }], itemIds = ['UP'], spy }: { initial?: Row[]; itemIds?: string[]; spy?: (r: Row[]) => void }) {
  const [rows, setRows] = useState<Row[]>(initial);
  return <ListEditor def={DEF} rows={rows} itemIds={itemIds} onChange={(r) => { setRows(r); spy?.(r); }} />;
}

describe('ListEditor', () => {
  it('shows only the product id columns the partner uses', () => {
    render(<Harness itemIds={['UP']} />);
    expect(screen.getByText('UPC (UP)')).toBeInTheDocument();
    expect(screen.queryByText('SKU (SK)')).toBeNull();
    expect(screen.getByText('Qty')).toBeInTheDocument();
  });

  it('shows every column the partner asks for', () => {
    render(<Harness itemIds={['SK', 'UP']} />);
    expect(screen.getByText('UPC (UP)')).toBeInTheDocument();
    expect(screen.getByText('SKU (SK)')).toBeInTheDocument();
  });

  it('adds and removes rows, but never below the minimum', () => {
    render(<Harness />);
    const remove = screen.getByLabelText('Remove row 1');
    expect(remove).toBeDisabled(); // one row is the minimum
    fireEvent.click(screen.getByText('+ Add line'));
    expect(screen.getByLabelText('Remove row 2')).toBeEnabled();
    fireEvent.click(screen.getByLabelText('Remove row 2'));
    expect(screen.queryByLabelText('Remove row 2')).toBeNull();
  });

  it('stops adding at the maximum', () => {
    render(<Harness initial={Array.from({ length: 5 }, () => ({ qty: '1', uom: 'EA', upc: '', sku: '', desc: '' }))} />);
    expect(screen.getByText('+ Add line')).toBeDisabled();
  });

  it('edits a cell', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.change(screen.getByLabelText('Line items 1 Qty'), { target: { value: '12' } });
    expect(spy).toHaveBeenLastCalledWith([expect.objectContaining({ qty: '12' })]);
  });

  it('imports rows pasted from Excel, matching columns by header name', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.click(screen.getByText('Paste / import'));
    fireEvent.change(screen.getByLabelText('Pasted rows'), { target: { value: 'Quantity\tGTIN\tItem Description\n5\t012345678905\tGummies\n20\t012345678912\tOmega' } });
    fireEvent.click(screen.getByText('Replace lines'));

    const rows = spy.mock.calls.at(-1)![0] as Row[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ qty: '5', upc: '012345678905', desc: 'Gummies', uom: 'EA' }); // unspecified selects get their default
    expect(screen.getByRole('status')).toHaveTextContent('Imported 2 lines');
  });

  it('adds pasted rows to what is there', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.click(screen.getByText('Paste / import'));
    fireEvent.change(screen.getByLabelText('Pasted rows'), { target: { value: 'Qty,Description\n7,Extra' } });
    fireEvent.click(screen.getByText('Add to lines'));
    expect(spy.mock.calls.at(-1)![0]).toHaveLength(2);
  });

  it('explains an unusable paste and changes nothing', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.click(screen.getByText('Paste / import'));
    fireEvent.change(screen.getByLabelText('Pasted rows'), { target: { value: 'Qty,Price\n' } });
    fireEvent.click(screen.getByText('Replace lines'));
    expect(screen.getByRole('status')).toHaveTextContent('No lines found');
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses an Excel file with a way forward, instead of failing quietly', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Paste / import'));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'orders.xlsx')] } });
    expect(await screen.findByText(/Excel files are not read directly/)).toBeInTheDocument();
  });
});
