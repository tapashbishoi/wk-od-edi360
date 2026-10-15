/** Shapes the test-EDI generator API sends and receives. They mirror backend/src/generator/types.ts. */

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
  maxLength?: number;
  ref?: string;
  mono?: boolean;
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

export type DocGroup = 'Retail' | 'Transportation' | 'Warehouse' | 'Acknowledgments';

export interface GeneratorDoc {
  code: string;
  name: string;
  group: DocGroup;
  description: string;
  defaultSender: 'partner' | 'us';
  sections: SectionDef[];
  lists: ListDef[];
}

export interface IsaParty {
  isaQual: string;
  isaId: string;
  gsId: string;
}

export interface Delimiters {
  element: string;
  segment: string;
  component: string;
  repetition: string;
}

export interface PartnerProfile {
  name: string;
  code: string;
  ours: IsaParty;
  theirs: IsaParty;
  x12Version: '004010' | '005010';
  usage: 'T' | 'P';
  ackRequested: boolean;
  delimiters: Delimiters;
  parties: { partner: Party; partnerShipTo: Party; ours: Party; oursShipFrom: Party };
  scac: string;
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
  docRules: Record<string, string>;
  docDefaults?: Record<string, Record<string, string>>;
  notes: string;
}

export interface SavedPartner {
  id: number;
  name: string;
  code: string;
  profile: PartnerProfile;
  isaControlNext: number;
  gsControlNext: number;
  updatedAt: string;
}

export interface Preset {
  key: string;
  label: string;
  description: string;
  partner: PartnerProfile;
}

export interface GenerateResult {
  text: string;
  compact: string;
  segments: string[];
  filename: string;
  warnings: string[];
  control: { isa: string; gs: string; st: string };
  stats: { segments: number; lines: number };
  sender: IsaParty;
  receiver: IsaParty;
  historyId?: number;
}

export interface GeneratedFile {
  id: number;
  partner_name: string | null;
  doc_type: string;
  sender: 'partner' | 'us';
  filename: string;
  isa_control: string | null;
  gs_control: string | null;
  segments: number | null;
  warnings: number;
  created_at: string;
}

/** A real trading partner seen in the tenant's traffic, with a profile read from its latest EDI envelope. */
export interface TrafficPartner {
  partnerId: string;
  name: string;
  types: string[];
  /** false when nothing was converted yet and only the ISA ids are known */
  fromEnvelope: boolean;
  profile: PartnerProfile;
}
