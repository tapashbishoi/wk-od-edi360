import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { InviteResult, Member, MemberRole } from '@/types';
import { Button, Card, ErrorNote, inputClass } from '@/components/ui';
import CopyButton from '@/components/CopyButton';
import { formatTime, timeAgo } from '@/utils/status';

const ROLE_LABEL: Record<MemberRole, string> = {
  customer_admin: 'Administrator',
  support: 'Support',
  business: 'Business',
  auditor: 'Auditor',
};

const STATUS_STYLE: Record<Member['status'], string> = {
  active: 'bg-green-100 text-green-800',
  invited: 'bg-blue-100 text-blue-800',
  disabled: 'bg-gray-100 text-gray-600',
};

/**
 * The people at a customer who can sign in to see its transactions. An admin adds
 * a member and picks a role; the member gets a one-time link to set a password.
 * The link is always shown here as well as emailed, so a member is never stranded
 * by a missing Brevo setup or a bounced address.
 */
export default function MembersCard({ tenantId, timezone }: { tenantId: number; timezone?: string }) {
  const me = useAuthStore((s) => s.user);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [roles, setRoles] = useState<{ role: MemberRole; description: string }[]>([]);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<(InviteResult & { email: string }) | null>(null);

  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [role, setRole] = useState<MemberRole>('business');

  const load = useCallback(async () => {
    try {
      const d = await api.members(tenantId);
      setMembers(d.members);
      setRoles(d.roles);
      setEmailConfigured(d.emailConfigured);
    } catch (e) {
      setError(errorMessage(e, 'Could not load members'));
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void act('add', async () => {
      const r = await api.addMember(tenantId, { email: email.trim(), role, firstName: firstName.trim() || undefined, lastName: lastName.trim() || undefined });
      setLink({ ...r, email: email.trim() });
      setEmail('');
      setFirstName('');
      setLastName('');
    });
  };

  const roleHelp = roles.find((r) => r.role === role)?.description;

  return (
    <Card title={`Members${members ? ` (${members.length})` : ''}`} className="lg:col-span-2">
      {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}

      {link && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm" role="status">
          <p className="font-medium text-green-900">
            {link.emailed ? `An invitation was emailed to ${link.email}.` : `Share this link with ${link.email}.`}
          </p>
          {!link.emailed && link.emailError && <p className="mt-0.5 text-xs text-amber-800">Email not sent: {link.emailError}</p>}
          <p className="mt-1 flex items-center gap-2 break-all font-mono text-xs text-green-900">
            {link.inviteUrl}
            <CopyButton value={link.inviteUrl} label="Copy link" />
          </p>
          <p className="mt-1 text-xs text-green-800">Works once and expires {formatTime(link.inviteExpiresAt, timezone)}. It won't be shown again.</p>
          <button className="mt-2 text-xs text-green-800 underline" onClick={() => setLink(null)}>Done</button>
        </div>
      )}

      <form onSubmit={add} className="mb-5 grid gap-3 md:grid-cols-12">
        <label className="text-xs font-medium text-gray-500 md:col-span-4">
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@customer.com" className={`${inputClass} mt-1 w-full`} aria-label="Member email" />
        </label>
        <label className="text-xs font-medium text-gray-500 md:col-span-2">
          First name
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className={`${inputClass} mt-1 w-full`} aria-label="First name" />
        </label>
        <label className="text-xs font-medium text-gray-500 md:col-span-2">
          Last name
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} className={`${inputClass} mt-1 w-full`} aria-label="Last name" />
        </label>
        <label className="text-xs font-medium text-gray-500 md:col-span-2">
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as MemberRole)} className={`${inputClass} mt-1 w-full`} aria-label="Member role">
            {roles.map((r) => <option key={r.role} value={r.role}>{ROLE_LABEL[r.role]}</option>)}
          </select>
        </label>
        <div className="flex items-end md:col-span-2">
          <Button type="submit" isLoading={busy === 'add'} disabled={!email.includes('@')} className="w-full">Add member</Button>
        </div>
        <p className="text-xs text-gray-500 md:col-span-12">
          {roleHelp}{' '}
          {emailConfigured
            ? 'They will be emailed a link to set their password.'
            : "Email isn't set up for this tenant, so you'll get a link to pass on yourself. Save a Brevo key above to send it automatically."}
        </p>
      </form>

      {!members ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : members.length === 0 ? (
        <p className="text-sm text-gray-500">No members yet. Add the first person above and they can sign in to see this tenant's transactions.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
              <tr><th className="py-2 pr-3">Member</th><th className="pr-3">Role</th><th className="pr-3">Status</th><th className="pr-3">Last sign-in</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {members.map((m) => {
                const isMe = m.id === me?.id;
                return (
                  <tr key={m.id} data-testid={`member-${m.email}`}>
                    <td className="py-2 pr-3">
                      <p className="font-medium text-gray-900">{[m.firstName, m.lastName].filter(Boolean).join(' ') || m.email}{isMe && <span className="ml-2 text-xs text-gray-400">(you)</span>}</p>
                      {(m.firstName || m.lastName) && <p className="text-xs text-gray-500">{m.email}</p>}
                    </td>
                    <td className="pr-3">
                      <select
                        value={m.role}
                        disabled={busy === `role-${m.id}`}
                        onChange={(e) => act(`role-${m.id}`, async () => void (await api.updateMember(tenantId, m.id, { role: e.target.value as MemberRole })))}
                        className={`${inputClass} py-1`}
                        aria-label={`Role for ${m.email}`}
                      >
                        {roles.map((r) => <option key={r.role} value={r.role}>{ROLE_LABEL[r.role]}</option>)}
                      </select>
                    </td>
                    <td className="pr-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[m.status]}`}>{m.status}</span>
                    </td>
                    <td className="pr-3 text-gray-600" title={m.lastLogin ?? ''}>{m.lastLogin ? timeAgo(m.lastLogin) : m.status === 'invited' ? 'Not yet' : 'Never'}</td>
                    <td className="space-x-2 whitespace-nowrap text-right">
                      {m.isActive && (
                        <Button
                          size="sm"
                          variant="secondary"
                          isLoading={busy === `invite-${m.id}`}
                          onClick={() => act(`invite-${m.id}`, async () => setLink({ ...(await api.inviteMember(tenantId, m.id)), email: m.email }))}
                        >
                          {m.status === 'invited' ? 'Resend invite' : 'Reset password'}
                        </Button>
                      )}
                      {!isMe && (
                        <Button
                          size="sm"
                          variant="secondary"
                          isLoading={busy === `active-${m.id}`}
                          onClick={() => act(`active-${m.id}`, async () => void (await api.updateMember(tenantId, m.id, { isActive: !m.isActive })))}
                        >
                          {m.isActive ? 'Disable' : 'Enable'}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
