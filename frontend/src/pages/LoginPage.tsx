import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Button, ErrorNote, inputClass } from '@/components/ui';
import BrandLogo from '@/components/brand/BrandLogo';
import BrandMark from '@/components/brand/BrandMark';
import FlowAnimation from '@/components/brand/FlowAnimation';

const HIGHLIGHTS = [
  { icon: '👁', title: 'Every document, one view', text: 'Orders, acknowledgments, shipments and invoices tracked from partner to ERP.' },
  { icon: '✅', title: '997 monitoring', text: 'Know the moment an acknowledgment is late, rejected or missing.' },
  { icon: '🔔', title: 'Alerts and tickets', text: 'Email reminders, and Jira or ServiceNow tickets raised in a click.' },
  { icon: '💬', title: 'EDI in plain English', text: 'Any document explained for business and technical teams alike.' },
];

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoading, error, user, token } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (token && user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await login(email.trim(), password)) navigate('/');
  };

  return (
    <div className="grid min-h-screen bg-white lg:grid-cols-[1.15fr_1fr]">
      {/* sign in */}
      <main className="order-1 flex flex-col justify-between px-6 py-8 sm:px-12 lg:order-2">
        <div className="lg:hidden"><BrandLogo name="United Techno" file="united-techno" className="h-10 w-36" imgClass="h-9" /></div>
        <form onSubmit={submit} className="mx-auto w-full max-w-sm space-y-5 py-10">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">Welcome back</h1>
            <p className="mt-1 text-sm text-gray-500">Sign in to EDI360.</p>
          </div>

          {error && <ErrorNote>{error}</ErrorNote>}

          <label className="block text-sm font-medium text-gray-700">
            Email
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className={`${inputClass} mt-1 w-full`} />
          </label>
          <label className="block text-sm font-medium text-gray-700">
            Password
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={`${inputClass} mt-1 w-full`} />
          </label>

          <Button type="submit" isLoading={isLoading} className="w-full">Sign in</Button>
        </form>

        {/* the three names behind the platform */}
        <footer className="border-t border-gray-100 pt-5">
          <p className="mb-3 pl-[0.2em] text-center text-[11px] font-semibold uppercase tracking-widest text-gray-400">Built by · Powered by · Connected to</p>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <BrandLogo name="United Techno" file="united-techno" imgClass="h-9" />
            <BrandLogo name="Workato" file="workato" imgClass="h-8" />
            <BrandLogo name="Orderful" file="orderful" imgClass="h-6" />
          </div>
        </footer>
      </main>

      {/* what the platform is */}
      <aside className="relative order-2 overflow-hidden bg-slate-900 px-6 py-10 text-white sm:px-12 lg:order-1 lg:flex lg:flex-col lg:justify-center">
        <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-blue-600/30 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-80 w-80 rounded-full bg-emerald-500/20 blur-3xl" aria-hidden />

        <div className="relative mx-auto w-full max-w-xl animate-rise-in">
          <BrandMark dark className="text-2xl" />
          <h2 className="mt-3 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
            Every EDI document.<br /><span className="bg-gradient-to-r from-sky-300 to-emerald-300 bg-clip-text text-transparent">A true 360° view.</span>
          </h2>
          <p className="mt-3 max-w-md text-sm text-slate-300 sm:text-base">
            Follow each order, shipment and invoice from your trading partner through Orderful and Workato into your ERP, and back again.
          </p>

          <div className="mt-8"><FlowAnimation /></div>

          <ul className="mt-8 grid gap-4 sm:grid-cols-2">
            {HIGHLIGHTS.map((h) => (
              <li key={h.title} className="flex gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-lg" aria-hidden>{h.icon}</span>
                <div>
                  <p className="text-sm font-semibold">{h.title}</p>
                  <p className="text-xs leading-relaxed text-slate-400">{h.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
