import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'success';
  isLoading?: boolean;
  size?: 'sm' | 'md';
}

const VARIANTS = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700',
  secondary: 'bg-white text-gray-800 ring-1 ring-inset ring-gray-300 hover:bg-gray-50',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  success: 'bg-green-600 text-white hover:bg-green-700',
};

export function Button({ variant = 'primary', isLoading = false, size = 'md', className = '', disabled, children, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || isLoading}
      className={`rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${size === 'sm' ? 'px-3 py-1 text-sm' : 'px-4 py-2'} ${VARIANTS[variant]} ${className}`}
    >
      {isLoading ? 'Working...' : children}
    </button>
  );
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg bg-white p-5 shadow-sm ring-1 ring-gray-200 ${className}`}>
      {(title || actions) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-base font-semibold text-gray-900">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center">
      <p className="font-medium text-gray-900">{title}</p>
      {children && <div className="mt-1 text-sm text-gray-500">{children}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      {children}
    </div>
  );
}

export const inputClass =
  'rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200';
