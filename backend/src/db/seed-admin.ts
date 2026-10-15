import crypto from 'crypto';
import { query, queryOne, closePool } from './connection.js';
import { AuthService } from '../services/auth.service.js';

/**
 * Creates a user and prints a temporary password once.
 *
 *   npm run db:create-admin -- --email=you@company.com
 *   npm run db:create-admin -- --email=ops@customer.com --role=customer_admin --tenant=nordic_naturals
 *
 * There is no self-signup and no API to create the first admin, by design.
 */
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

async function main() {
  const email = arg('email');
  const role = arg('role') ?? 'platform_admin';
  const tenantSlug = arg('tenant');

  if (!email) throw new Error('--email is required');
  if (!['platform_admin', 'customer_admin', 'support', 'business', 'auditor'].includes(role)) {
    throw new Error(`Unknown role: ${role}`);
  }

  let tenantId: number | null = null;
  if (role !== 'platform_admin') {
    if (!tenantSlug) throw new Error(`--tenant=<slug> is required for role ${role}`);
    const tenant = await queryOne<{ id: number }>(`SELECT id FROM wk_tenants WHERE slug = $1`, [tenantSlug]);
    if (!tenant) throw new Error(`No tenant with slug "${tenantSlug}"`);
    tenantId = tenant.id;
  }

  const temp = crypto.randomBytes(12).toString('base64url');
  await query(`INSERT INTO wk_users (email, password_hash, role, tenant_id) VALUES ($1,$2,$3,$4)`, [
    email,
    await AuthService.hashPassword(temp),
    role,
    tenantId,
  ]);

  console.log(`\nCreated ${role} ${email}\nTemporary password (shown once): ${temp}\n`);
}

main()
  .catch((error) => {
    console.error('Failed:', error.message);
    process.exitCode = 1;
  })
  .finally(closePool);
