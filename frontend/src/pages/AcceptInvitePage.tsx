import BrandMark from '@/components/brand/BrandMark';
import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import { Button, ErrorNote, inputClass } from '@/components/ui';
import Spinner from '@/components/Spinner';

/** Public page behind an invitation link: the person sets a password and is signed in. */
export default function AcceptInvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const startSession = useAuthStore((s) => s.startSession);
  const [info, setInfo] = useState<{ email: string; firstName: string | null; tenantName: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.inviteInfo(token).then(setInfo).catch((e) => setProblem(errorMessage(e, 'This invitation link is not valid.')));
  }, [token]);

  const mismatch = confirm.length > 0 && password !== confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      await startSession(await api.acceptInvite(token, password));
      navigate('/');
    } catch (err) {
      setError(errorMessage(err, 'Could not set your password'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-sm ring-1 ring-gray-200">
        <h1><BrandMark className="text-2xl" /></h1>

        {problem ? (
          <div className="mt-4 space-y-3">
            <ErrorNote>{problem}</ErrorNote>
            <a href="/login" className="text-sm text-blue-600 hover:underline">Go to sign in</a>
          </div>
        ) : !info ? (
          <Spinner />
        ) : (
          <form onSubmit={submit} className="mt-1 space-y-4">
            <p className="text-sm text-gray-500">
              {info.firstName ? `Welcome, ${info.firstName}. ` : 'Welcome. '}
              Set a password to follow <strong>{info.tenantName}</strong>'s EDI transactions.
            </p>
            <p className="rounded bg-gray-50 px-3 py-2 text-sm text-gray-700">{info.email}</p>

            {error && <ErrorNote>{error}</ErrorNote>}

            <label className="block text-sm font-medium text-gray-700">
              Password
              <input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} className={`${inputClass} mt-1 w-full`} />
              <span className="mt-1 block text-xs font-normal text-gray-500">At least 10 characters. A few words together works well.</span>
            </label>
            <label className="block text-sm font-medium text-gray-700">
              Confirm password
              <input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className={`${inputClass} mt-1 w-full`} />
              {mismatch && <span className="mt-1 block text-xs font-normal text-red-600">The passwords don't match.</span>}
            </label>

            <Button type="submit" isLoading={busy} disabled={password.length < 10 || mismatch || confirm.length === 0} className="w-full">
              Set password and sign in
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
