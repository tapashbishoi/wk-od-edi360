/** X12 code lists the portal spells out, checked against Stedi's X12 004010 reference. */

/** BAK02 / element 587, Acknowledgment Type on an 855. */
export const ACK_TYPES: Record<string, string> = {
  AC: 'Acknowledged with detail and change',
  AD: 'Acknowledged with detail, no change',
  AE: 'Acknowledged with exception detail only',
  AH: 'Acknowledged, hold status',
  AK: 'Acknowledged, no detail or change',
  AP: 'Acknowledged, product replenishment',
  AT: 'Accepted',
  NA: 'No acknowledgment needed',
  RD: 'Rejected with detail',
  RF: 'Rejected with exception detail only',
  RJ: 'Rejected, no detail',
  RN: 'Rejected, not as agreed',
  RO: 'Rejected with counter offer',
  RV: 'Rejected, violates industry practices',
  ZZ: 'Mutually defined',
};

/** ACK01, Line Item Status Code on an 855. */
export const LINE_ACK_STATUS: Record<string, string> = {
  IA: 'Item accepted',
  IB: 'Item backordered',
  IC: 'Item accepted, changes made',
  IR: 'Item rejected',
  DR: 'Item accepted, date rescheduled',
};
