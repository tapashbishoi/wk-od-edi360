import type { DocDef, DocGroup } from './types.js';
import { doc850, doc855, doc856, doc810 } from './docs/retail.js';
import { doc204, doc990, doc214, doc210 } from './docs/transport.js';
import { doc940, doc943, doc944, doc945 } from './docs/warehouse.js';
import { doc997 } from './docs/acks.js';

/** Every document the generator can build, in the order the UI lists them. */
export const DOCS: DocDef[] = [doc850, doc855, doc856, doc810, doc204, doc990, doc214, doc210, doc940, doc943, doc944, doc945, doc997];

const byCode = new Map(DOCS.map((d) => [d.code, d]));

export const getDoc = (code: string): DocDef | undefined => byCode.get(code);

export const GROUP_ORDER: DocGroup[] = ['Retail', 'Transportation', 'Warehouse', 'Acknowledgments'];

/** What the UI needs to draw a document's form: everything but the functions. */
export function describeDoc(d: DocDef) {
  return {
    code: d.code,
    name: d.name,
    group: d.group,
    description: d.description,
    defaultSender: d.defaultSender,
    sections: d.sections,
    lists: d.lists,
  };
}
