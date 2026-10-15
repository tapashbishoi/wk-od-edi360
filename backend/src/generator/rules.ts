import type { Delimiters, Seg } from './types.js';

/**
 * Partner rules: the partner's own quirks, expressed as text, one rule per line.
 *
 *   AFTER BEG: REF*DP*3          insert a segment after the first BEG
 *   REPLACE ITD: ITD**3***Net 45 swap the generated ITD for this one
 *   REMOVE PER                   drop every PER the generator wrote
 *
 * Lines starting with # are comments. The text after the colon is a segment written with the
 * partner's element separator. A rule that matches nothing is reported, never silently ignored.
 */

export interface RuleResult {
  segments: Seg[];
  warnings: string[];
}

const RULE = /^(AFTER|REPLACE)\s+([A-Z0-9]{2,3})\s*:\s*(.+)$/i;
const REMOVE = /^REMOVE\s+([A-Z0-9]{2,3})\s*$/i;

export function applyRules(body: Seg[], rules: string | undefined, delims: Delimiters): RuleResult {
  const warnings: string[] = [];
  if (!rules || !rules.trim()) return { segments: body, warnings };

  let segments = body.map((s) => [...s]);

  rules.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;

    const remove = line.match(REMOVE);
    if (remove) {
      const id = remove[1].toUpperCase();
      const before = segments.length;
      segments = segments.filter((s) => s[0] !== id);
      if (segments.length === before) warnings.push(`Rule ${i + 1} (REMOVE ${id}): no ${id} segment to remove.`);
      return;
    }

    const m = line.match(RULE);
    if (!m) {
      warnings.push(`Rule ${i + 1} not understood: "${line.slice(0, 60)}". Use AFTER XX: segment, REPLACE XX: segment or REMOVE XX.`);
      return;
    }

    const action = m[1].toUpperCase();
    const id = m[2].toUpperCase();
    const text = m[3].trim().replace(new RegExp(`${escapeRe(delims.segment)}$`), '');
    const seg = text.split(delims.element);
    if (!seg[0] || !/^[A-Z0-9]{2,3}$/.test(seg[0])) {
      warnings.push(`Rule ${i + 1}: "${text.slice(0, 40)}" does not start with a segment id.`);
      return;
    }

    const at = segments.findIndex((s) => s[0] === id);
    if (at === -1) {
      warnings.push(`Rule ${i + 1} (${action} ${id}): the document has no ${id} segment, so nothing was changed.`);
      return;
    }
    if (action === 'REPLACE') segments[at] = seg;
    else segments.splice(at + 1, 0, seg);
  });

  return { segments, warnings };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
