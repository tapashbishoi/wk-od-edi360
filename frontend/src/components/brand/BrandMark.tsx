/** The product name: EDI360, with the 360 picked out. `dark` is for use on a dark background. */
export default function BrandMark({ className = 'text-lg', dark = false }: { className?: string; dark?: boolean }) {
  return (
    <span className={`font-extrabold tracking-tight ${className} ${dark ? 'text-white' : 'text-gray-900'}`} aria-label="EDI360">
      EDI<span className={`bg-gradient-to-r bg-clip-text text-transparent ${dark ? 'from-sky-300 to-emerald-300' : 'from-blue-600 to-emerald-500'}`}>360</span>
    </span>
  );
}
