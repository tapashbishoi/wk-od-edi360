/**
 * The platform in motion: documents travelling the same four stops in each direction.
 * Inbound  - trading partner, Orderful, Workato, ERP.
 * Outbound - ERP, Workato, Orderful, trading partner.
 * Pure CSS (see the "flow-*" animations in tailwind.config.js); with reduced motion the packets are hidden
 * and the lanes still read as a static diagram.
 */

interface Packet { label: string; delay: number; tone: string }

const STOPS = { inbound: ['Trading partner', 'Orderful', 'Workato', 'ERP'], outbound: ['ERP', 'Workato', 'Orderful', 'Trading partner'] };

const PACKETS: Record<'inbound' | 'outbound', Packet[]> = {
  inbound: [
    { label: '850', delay: 0, tone: 'bg-sky-400 text-sky-950' },
    { label: '810', delay: 2.4, tone: 'bg-emerald-400 text-emerald-950' },
    { label: '856', delay: 4.8, tone: 'bg-violet-300 text-violet-950' },
  ],
  outbound: [
    { label: '855', delay: 1.2, tone: 'bg-amber-300 text-amber-950' },
    { label: '856', delay: 3.6, tone: 'bg-violet-300 text-violet-950' },
    { label: '997', delay: 6, tone: 'bg-emerald-400 text-emerald-950' },
  ],
};

function Lane({ direction }: { direction: 'inbound' | 'outbound' }) {
  const stops = STOPS[direction];
  const inbound = direction === 'inbound';
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${inbound ? 'bg-sky-400/15 text-sky-200' : 'bg-amber-300/15 text-amber-200'}`}>
          {inbound ? '↓ Inbound' : '↑ Outbound'}
        </span>
        <span className="text-xs text-slate-400">{inbound ? 'Partner sends us a document' : 'We send a partner a document'}</span>
      </div>
      <div className="relative">
        {/* the road the documents travel */}
        <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-white/5 via-white/30 to-white/5" aria-hidden />
        <div className="relative flex items-center justify-between">
          {stops.map((s, i) => (
            <div key={s} className="relative z-10 flex flex-col items-center">
              <div className="flex h-12 w-[4.5rem] items-center justify-center rounded-xl border border-white/15 bg-slate-800/90 px-1 text-center text-[11px] font-medium leading-tight text-slate-100 shadow-lg shadow-black/20 sm:w-24 sm:text-xs">
                {s}
              </div>
              <span className="mt-1 text-[10px] text-slate-500">{['Start', 'Validate', 'Process', 'Finish'][i]}</span>
            </div>
          ))}
        </div>
        {/* documents moving along it */}
        <div className="pointer-events-none absolute inset-x-8 top-[1.5rem] h-0 motion-reduce:hidden sm:inset-x-12" aria-hidden>
          {PACKETS[direction].map((p) => (
            <span
              key={p.label + p.delay}
              className={`absolute -top-3 flex h-6 min-w-[2.25rem] items-center justify-center rounded-full px-2 text-[11px] font-bold shadow-lg ${p.tone} ${inbound ? 'animate-flow-right' : 'animate-flow-left'}`}
              style={{ animationDelay: `${p.delay}s` }}
            >
              {p.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function FlowAnimation() {
  return (
    <div className="space-y-6 rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur-sm" role="img" aria-label="Documents flow inbound from a trading partner through Orderful and Workato to the ERP, and outbound in the reverse direction">
      <Lane direction="inbound" />
      <Lane direction="outbound" />
    </div>
  );
}
