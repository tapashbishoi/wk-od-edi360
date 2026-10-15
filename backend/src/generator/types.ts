/**
 * Types for the EDI test-file generator: partner profiles, document definitions, and the form
 * schema the UI renders from. Pure data, no behaviour.
 */

/** One X12 segment: the segment id followed by its elements. */
export type Seg = string[];

export interface Delimiters {
  element: string;
  segment: string;
  /** Component element separator (ISA16) */
  component: string;
  /** Repetition separator (ISA11 in 5010) */
  repetition: string;
}

export type FieldType = 'text' | 'textarea' | 'number' | 'date' | 'time' | 'select' | 'checkbox' | 'party';

export interface Option {
  value: string;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: Option[];
  required?: boolean;
  help?: string;
  placeholder?: string;
  /** Longest value the X12 element allows; longer values are warned about, never silently cut */
  maxLength?: number;
  /** The segment element this feeds, shown in warnings (e.g. BEG03) */
  ref?: string;
  mono?: boolean;
  /** For item-id columns: the X12 product id qualifier (UP, SK, VP, ...). The UI shows the column only if the partner uses it. */
  qualifier?: string;
}

export interface ListDef {
  key: string;
  label: string;
  addLabel: string;
  columns: FieldDef[];
  min: number;
  max: number;
}

export interface SectionDef {
  title: string;
  description?: string;
  fields: FieldDef[];
}

export interface Party {
  name: string;
  idQual: string;
  id: string;
  address: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export type Row = Record<string, string>;
export type Value = string | boolean | Party | Row[];
export type Values = Record<string, Value>;

export interface IsaParty {
  isaQual: string;
  isaId: string;
  gsId: string;
}

export interface PartnerProfile {
  name: string;
  /** Short code used in file names */
  code: string;
  /** Our side of the interchange */
  ours: IsaParty;
  /** The trading partner's side */
  theirs: IsaParty;
  x12Version: '004010' | '005010';
  /** T = test, P = production (ISA15) */
  usage: 'T' | 'P';
  ackRequested: boolean;
  delimiters: Delimiters;
  parties: {
    /** The partner as a company: buyer, carrier or warehouse, depending on the document */
    partner: Party;
    /** The partner's ship-to site (store, DC) */
    partnerShipTo: Party;
    /** Our company: vendor, shipper, remit-to */
    ours: Party;
    /** Our ship-from site (warehouse) */
    oursShipFrom: Party;
  };
  /** The partner's carrier code when the partner is a carrier (SCAC) */
  scac: string;
  /** Product id qualifiers this partner wants on item lines, in order (UP, SK, VP, VN, IN) */
  itemIds: string[];
  defaults: {
    vendorAccount: string;
    department: string;
    contactName: string;
    phone: string;
    email: string;
    termsDays: string;
    termsDescription: string;
    currency: string;
  };
  /**
   * Partner-specific tweaks per document, one rule per line:
   *   AFTER BEG: REF*DP*3         inserts a segment after the first BEG
   *   REPLACE ITD: ITD**3***Net   replaces the generated ITD with this text
   *   REMOVE PER                  drops the generated PER segments
   * The partner's own quirks, without a code change.
   */
  docRules: Record<string, string>;
  /** Per-document starting values for this partner (e.g. a freight charge on every 850) */
  docDefaults?: Record<string, Record<string, string>>;
  notes: string;
}

export interface BuildContext {
  partner: PartnerProfile;
  /** Who sends this file */
  sender: 'partner' | 'us';
  version: '004010' | '005010';
  now: Date;
  /** Records something the user should look at; never throws */
  warn: (message: string) => void;
}

export type DocGroup = 'Retail' | 'Transportation' | 'Warehouse' | 'Acknowledgments';

export interface DocDef {
  code: string;
  name: string;
  group: DocGroup;
  description: string;
  /** GS01 functional identifier code */
  functionalId: string;
  /** Who normally sends this document, so the default direction is right */
  defaultSender: 'partner' | 'us';
  sections: SectionDef[];
  lists: ListDef[];
  /** A starting point: partner defaults plus realistic sample data */
  sample: (ctx: BuildContext) => Values;
  /** The segments between ST and SE */
  build: (values: Values, ctx: BuildContext) => Seg[];
  /** The number a file is named after (PO, shipment, invoice...) */
  mainNumber: (values: Values) => string;
}

export interface GenerateRequest {
  docType: string;
  partner: PartnerProfile;
  sender: 'partner' | 'us';
  values: Values;
  control?: { isa?: number; gs?: number; st?: string };
  now?: Date;
}

export interface GenerateResult {
  /** The file, one segment per line */
  text: string;
  /** The file as a single line (how many partners expect it) */
  compact: string;
  /** Each segment, without its terminator, for the preview */
  segments: string[];
  filename: string;
  warnings: string[];
  control: { isa: string; gs: string; st: string };
  stats: { segments: number; lines: number };
  sender: IsaParty;
  receiver: IsaParty;
}
