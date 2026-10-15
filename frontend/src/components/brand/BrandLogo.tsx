import { useState } from 'react';

/**
 * A partner or company logo loaded from /logos (frontend/public/logos). Until the file is there, or if it
 * cannot be loaded, the name is shown as a plain wordmark, so the page never has a broken image.
 * Tries .svg first, then .png.
 *
 * Every logo sits in the same fixed-size cell, centred both ways, so logos with different proportions
 * and padding still line up. A light image background is multiplied into the page so it disappears.
 */
const EXTENSIONS = ['svg', 'png'];

/** imgClass sets the logo's own height (their artwork has different margins, so each is sized by eye to match). */
export default function BrandLogo({ name, file, className = 'h-10 w-36', imgClass = 'max-h-full' }: { name: string; file: string; className?: string; imgClass?: string }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <div className={`flex items-center justify-center ${className}`}>
      {attempt >= EXTENSIONS.length ? (
        <span className="text-base font-semibold tracking-tight text-gray-700">{name}</span>
      ) : (
        <img
          src={`/logos/${file}.${EXTENSIONS[attempt]}`}
          alt={name}
          className={`${imgClass} max-w-full rounded-sm object-contain mix-blend-multiply`}
          onError={() => setAttempt((a) => a + 1)}
        />
      )}
    </div>
  );
}
