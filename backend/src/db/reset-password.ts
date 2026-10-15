import crypto from 'crypto';
import { query, closePool } from './connection.js';
import { AuthService } from '../services/auth.service.js';

/**
 * Sets a new temporary password for an existing user and prints it once.
 * There is no reset screen yet, so this is the way back in if one is lost.
 *
 *   npm run db:reset-password -- --email=you@company.com
 */
const email = process.argv.find((a) => a.startsWith('--email='))?.split('=').slice(1).join('=');

async function main() {
  if (!email) throw new Error('--email is required');

  const temp = crypto.randomBytes(12).toString('base64url');
  const result = await query(`UPDATE wk_users SET password_hash = $2, is_active = true WHERE lower(email) = lower($1)`, [
    email,
    await AuthService.hashPassword(temp),
  ]);
  if (result.rowCount === 0) throw new Error(`No user with email ${email}`);

  console.log(`\nPassword reset for ${email}\nTemporary password (shown once): ${temp}\n`);
}

main()
  .catch((error) => {
    console.error('Failed:', error.message);
    process.exitCode = 1;
  })
  .finally(closePool);
