import type { FieldDef, Option } from '../types.js';

/** Small constructors so document schemas read as a list of fields, not a wall of objects. */
type Extra = Partial<FieldDef>;

export const text = (key: string, label: string, extra: Extra = {}): FieldDef => ({ key, label, type: 'text', ...extra });
export const area = (key: string, label: string, extra: Extra = {}): FieldDef => ({ key, label, type: 'textarea', ...extra });
export const num = (key: string, label: string, extra: Extra = {}): FieldDef => ({ key, label, type: 'number', ...extra });
export const date = (key: string, label: string, extra: Extra = {}): FieldDef => ({ key, label, type: 'date', ...extra });
export const time = (key: string, label: string, extra: Extra = {}): FieldDef => ({ key, label, type: 'time', ...extra });
export const check = (key: string, label: string, extra: Extra = {}): FieldDef => ({ key, label, type: 'checkbox', ...extra });
export const select = (key: string, label: string, options: Option[], extra: Extra = {}): FieldDef => ({ key, label, type: 'select', options, ...extra });
export const partyField = (key: string, label: string, extra: Extra = {}): FieldDef => ({ key, label, type: 'party', ...extra });

const opts = (pairs: [string, string][]): Option[] => pairs.map(([value, label]) => ({ value, label: `${value} - ${label}` }));

// Code lists, each value checked against the X12 004010 code lists (Stedi's reference) when this was written.
export const PURPOSE_OPTIONS = opts([['00', 'Original'], ['01', 'Cancellation'], ['05', 'Replace'], ['07', 'Duplicate']]);
export const PO_TYPE_OPTIONS = opts([['SA', 'Stand-alone order'], ['NE', 'New order'], ['DS', 'Dropship'], ['RL', 'Release or delivery order'], ['BK', 'Blanket order'], ['KN', 'Kanban order']]);
export const ACK_TYPE_OPTIONS = opts([['AD', 'Acknowledge with detail, no change'], ['AC', 'Acknowledge with detail and change'], ['AK', 'Acknowledge, no detail or change'], ['RJ', 'Rejected, no detail'], ['RD', 'Rejected with detail']]);
export const LINE_ACK_OPTIONS = opts([['IA', 'Item accepted'], ['IB', 'Item backordered'], ['IC', 'Accepted, changes made'], ['IR', 'Item rejected'], ['DR', 'Accepted, date rescheduled']]);
export const CURRENCY_OPTIONS: Option[] = [{ value: '', label: 'None' }, { value: 'USD', label: 'USD' }, { value: 'CAD', label: 'CAD' }, { value: 'EUR', label: 'EUR' }, { value: 'GBP', label: 'GBP' }, { value: 'MXN', label: 'MXN' }];
export const PAYMENT_OPTIONS = opts([['PP', 'Prepaid (by seller)'], ['CC', 'Collect'], ['TP', 'Third party pay'], ['PC', 'Prepaid but charged to customer'], ['PU', 'Pickup']]);
export const TRANSPORT_OPTIONS = opts([['M', 'Motor (common carrier)'], ['LT', 'Less than truckload'], ['U', 'Private parcel service'], ['A', 'Air'], ['R', 'Rail']]);
export const WEIGHT_UNIT_OPTIONS = opts([['L', 'Pounds'], ['K', 'Kilograms']]);
export const CONTACT_FUNCTION_OPTIONS = opts([['BD', 'Buyer name or department'], ['IC', 'Information contact'], ['OC', 'Order contact']]);
export const PACKAGING_OPTIONS = opts([['CTN', 'Carton'], ['PLT', 'Pallet'], ['CAS', 'Case'], ['BOX', 'Box']]);
export const INVOICE_TYPE_OPTIONS = opts([['DI', 'Debit invoice'], ['CR', 'Credit memo']]);
export const TENDER_ACTION_OPTIONS = opts([['A', 'Accepted'], ['D', 'Declined']]);
export const STOP_REASON_OPTIONS = opts([['LD', 'Load'], ['UL', 'Unload'], ['CL', 'Complete (load)'], ['CU', 'Complete unload'], ['PL', 'Part load'], ['PU', 'Part unload']]);
export const LOAD_PURPOSE_OPTIONS = opts([['00', 'Original'], ['04', 'Change'], ['01', 'Cancellation'], ['05', 'Replace']]);
export const STATUS_CODE_OPTIONS = opts([
  ['X3', 'Arrived at pick-up location'], ['AF', 'Carrier departed pick-up location with shipment'], ['X6', 'En route to delivery location'],
  ['X1', 'Arrived at delivery location'], ['D1', 'Completed unloading at delivery location'], ['CD', 'Carrier departed delivery location'],
  ['AG', 'Estimated delivery'], ['AM', 'Loaded on truck'], ['AV', 'Available for delivery'], ['AH', 'Attempted delivery'], ['A3', 'Shipment returned to shipper'],
]);
export const STATUS_REASON_OPTIONS = opts([['NS', 'Normal status'], ['AI', 'Mechanical breakdown'], ['A1', 'Missed delivery'], ['AF', 'Accident'], ['AD', 'Customer requested future delivery']]);
export const CHARGE_CODE_OPTIONS = opts([['', 'None'], ['FUE', 'Fuel charge'], ['LFT', 'Lift gate'], ['RES', 'Residential delivery'], ['IDL', 'Inside delivery'], ['DET', 'Detention'], ['MSC', 'Other accessorial']]);
export const RATE_QUALIFIER_OPTIONS = opts([['FR', 'Flat rate'], ['CW', 'Per hundredweight'], ['PM', 'Per mile']]);
export const SHIP_STATUS_OPTIONS = opts([['CC', 'Shipment complete'], ['CP', 'Partial shipment'], ['BP', 'Partial, remainder backordered'], ['CS', 'Complete with substitution']]);
export const FUNCTIONAL_ID_OPTIONS = opts([['PO', 'Purchase orders (850)'], ['PR', 'PO acknowledgments (855)'], ['SH', 'Ship notices (856)'], ['IN', 'Invoices (810)'], ['SM', 'Load tenders (204)'], ['GF', 'Load tender responses (990)'], ['QM', 'Shipment status (214)'], ['IM', 'Freight invoices (210)'], ['OW', 'Warehouse shipping orders (940)'], ['AR', 'Warehouse stock transfer shipment advice (943)'], ['RE', 'Warehouse receipt advice (944)'], ['SW', 'Warehouse shipping advice (945)']]);
export const ACK_STATUS_OPTIONS = opts([['A', 'Accepted'], ['E', 'Accepted, but errors were noted'], ['R', 'Rejected']]);
export const ID_QUALIFIER_OPTIONS: Option[] = [{ value: '92', label: '92 - Assigned by buyer' }, { value: '91', label: '91 - Assigned by seller' }, { value: '93', label: '93 - Assigned by originator' }, { value: 'UL', label: 'UL - UCC/EAN location number (GLN)' }, { value: '9', label: '9 - DUNS+4' }, { value: '1', label: '1 - DUNS' }];
export const WAREHOUSE_ORDER_STATUS_OPTIONS = opts([['N', 'Original'], ['R', 'Change'], ['C', 'Confirmation'], ['F', 'Cancel'], ['D', 'Delete']]);
export const REPORTING_CODE_OPTIONS = opts([['F', 'Full detail'], ['N', 'No exceptions'], ['X', 'Exceptions only'], ['J', 'Original transaction']]);
