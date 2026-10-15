import type { DocDef, Seg } from '../types.js';
import { S } from '../x12.js';
import { str } from './common.js';
import { ACK_STATUS_OPTIONS, FUNCTIONAL_ID_OPTIONS, text, select } from './fields.js';

/** 997 Functional Acknowledgment: the receiver's "I got your file, here is what was wrong with it". */

export const doc997: DocDef = {
  code: '997',
  name: 'Functional Acknowledgment',
  group: 'Acknowledgments',
  description: 'Acknowledges receipt of a transaction, accepting or rejecting it. Use it to test how your system handles a partner\'s 997.',
  functionalId: 'FA',
  defaultSender: 'us',
  // The portal identifies a 997 by the group control number it acknowledges (AK102)
  mainNumber: (v) => str(v.ackedGroupCtrl) || str(v.ackedSetCtrl),
  sections: [
    {
      title: 'The file being acknowledged',
      fields: [
        select('ackedFunctionalId', 'Functional group (GS01)', FUNCTIONAL_ID_OPTIONS, { required: true, ref: 'AK101' }),
        text('ackedGroupCtrl', 'Group control number (GS06)', { required: true, maxLength: 9, ref: 'AK102', mono: true }),
        text('ackedSetCode', 'Transaction set', { required: true, maxLength: 3, ref: 'AK201', mono: true }),
        text('ackedSetCtrl', 'Set control number (ST02)', { required: true, maxLength: 9, ref: 'AK202', mono: true }),
      ],
    },
    {
      title: 'Result',
      fields: [
        select('status', 'Result', ACK_STATUS_OPTIONS, { required: true, ref: 'AK501' }),
        text('errorCode', 'Error code (AK502)', { maxLength: 3, help: 'Used when the result is not "Accepted", e.g. 5 = one or more segments in error.', mono: true }),
      ],
    },
  ],
  lists: [],
  sample: () => ({ ackedFunctionalId: 'PO', ackedGroupCtrl: '1', ackedSetCode: '850', ackedSetCtrl: '0001', status: 'A', errorCode: '' }),
  build: (v) => {
    const status = str(v.status) || 'A';
    const accepted = status === 'R' ? 0 : 1;
    const out: Seg[] = [
      S('AK1', { 1: str(v.ackedFunctionalId), 2: str(v.ackedGroupCtrl) }),
      S('AK2', { 1: str(v.ackedSetCode), 2: str(v.ackedSetCtrl) }),
      S('AK5', { 1: status, 2: status === 'A' ? '' : str(v.errorCode) }),
      // AK9: group result, then sets included, received and accepted
      S('AK9', { 1: status, 2: 1, 3: 1, 4: accepted }),
    ];
    return out;
  },
};
