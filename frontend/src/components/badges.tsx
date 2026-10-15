import type { Direction, Environment } from '@/types';
import { DIRECTION_LABEL, ENV_LABEL, TONE_STYLES, toneOf } from '@/utils/status';

export function StatusBadge({ status, className = '' }: { status: string | null | undefined; className?: string }) {
  const s = TONE_STYLES[toneOf(status)];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${s.badge} ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {status ?? 'Unknown'}
    </span>
  );
}

/**
 * Test and production data must never be mistaken for each other, so production
 * is a solid dark badge and test an amber outline.
 */
export function EnvBadge({ environment }: { environment: Environment }) {
  const style =
    environment === 'production'
      ? 'bg-gray-900 text-white'
      : environment === 'test'
        ? 'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-300'
        : 'bg-gray-100 text-gray-500 ring-1 ring-inset ring-gray-200';
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${style}`}>{ENV_LABEL[environment]}</span>;
}

export function DirectionBadge({ direction }: { direction: Direction }) {
  const arrow = direction === 'inbound' ? '↓' : direction === 'outbound' ? '↑' : '↕';
  return (
    <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">
      <span aria-hidden="true">{arrow}</span>
      {DIRECTION_LABEL[direction]}
    </span>
  );
}
