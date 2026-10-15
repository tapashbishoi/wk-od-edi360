import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * The assistant's reply as safe React nodes: **bold**, "- " bullets, and [text](link). Nothing is ever
 * inserted as HTML. A link is followed only if it goes to a portal page or is https; anything else is shown
 * as plain text, so a link smuggled in through partner data or a ticket comment cannot send anyone elsewhere.
 */

const INTERNAL = /^\/(transactions|tickets)\/\d+$|^\/(partners|transactions|tickets)$/;
const TOKEN = /(\[[^\]\n]{1,200}\]\([^)\s]{1,300}\)|\*\*[^*\n]{1,200}\*\*)/g;

export function isSafeLink(url: string): 'internal' | 'external' | null {
  if (INTERNAL.test(url)) return 'internal';
  return /^https:\/\/[^\s]+$/i.test(url) ? 'external' : null;
}

function inline(line: string, keyBase: string): ReactNode[] {
  return line.split(TOKEN).filter((s) => s !== '').map((part, i) => {
    const key = `${keyBase}-${i}`;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const kind = isSafeLink(link[2]);
      if (kind === 'internal') return <Link key={key} to={link[2]} className="font-medium text-blue-700 underline">{link[1]}</Link>;
      if (kind === 'external') return <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-700 underline">{link[1]}</a>;
      return <span key={key}>{link[1]}</span>;
    }
    const bold = /^\*\*([^*]+)\*\*$/.exec(part);
    if (bold) return <strong key={key}>{bold[1]}</strong>;
    return <span key={key}>{part}</span>;
  });
}

export function renderChatText(text: string): ReactNode {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      const items = bullets;
      out.push(<ul key={`ul-${out.length}`} className="my-1 list-disc space-y-0.5 pl-5">{items.map((b, i) => <li key={i}>{inline(b, `li-${out.length}-${i}`)}</li>)}</ul>);
      bullets = [];
    }
  };
  lines.forEach((raw, i) => {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(raw);
    if (bullet) { bullets.push(bullet[1]); return; }
    flush();
    if (raw.trim() === '') return;
    out.push(<p key={`p-${i}`} className="my-1">{inline(raw, `p-${i}`)}</p>);
  });
  flush();
  return <>{out}</>;
}
