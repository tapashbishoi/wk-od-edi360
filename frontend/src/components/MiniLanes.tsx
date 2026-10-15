import type { CanonicalStatus, Direction, LaneType } from '@/types';
import { TONE_STYLES, laneOrder, laneTitle, toneOf } from '@/utils/status';

/**
 * The three blocks as a compact strip for list rows: three dots in business
 * order joined by lines. Inbound reads Orderful > Workato > Target, outbound the
 * reverse, matching the detail page.
 */
export default function MiniLanes({ direction, stages }: { direction: Direction; stages: Partial<Record<LaneType, CanonicalStatus>> | null }) {
  const order = laneOrder(direction);
  return (
    <span className="inline-flex items-center" role="img" aria-label={order.map((l) => `${laneTitle(l, direction)}: ${stages?.[l] ?? 'Unknown'}`).join(', ')}>
      {order.map((lane, i) => {
        const status = stages?.[lane] ?? 'Unknown';
        return (
          <span key={lane} className="inline-flex items-center">
            <span title={`${laneTitle(lane, direction)}: ${status}`} className={`h-3 w-3 rounded-full ${TONE_STYLES[toneOf(status)].dot}`} />
            {i < order.length - 1 && <span className="h-px w-3 bg-gray-300" />}
          </span>
        );
      })}
    </span>
  );
}
