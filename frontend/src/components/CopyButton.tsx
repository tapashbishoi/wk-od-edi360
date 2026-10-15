import { useState } from 'react';

/** Copies a value (an id, a PO) to the clipboard. Silent when the browser refuses. */
export default function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch {
      /* clipboard unavailable (insecure context, permission) */
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={`${label}: ${value}`}
      aria-label={`${label} ${value}`}
      className="rounded px-1 text-[11px] text-gray-400 hover:bg-gray-100 hover:text-gray-700"
    >
      {done ? '✓' : '⧉'}
    </button>
  );
}
