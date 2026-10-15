import { useEffect, type ReactNode } from 'react';

/** A centred dialog that closes on Escape or a click on the backdrop. */
export default function Modal({ title, subtitle, onClose, children, wide = false }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} className={`mt-10 w-full ${wide ? 'max-w-4xl' : 'max-w-2xl'} rounded-xl bg-white shadow-xl`}>
        <div className="flex items-start justify-between border-b border-gray-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{title}</h2>
            {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-2xl leading-none text-gray-400 hover:text-gray-700">×</button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}
