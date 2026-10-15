import { queryOne } from '../../db/connection.js';
import { decryptSecret } from '../../utils/crypto.js';

/** The tenant's saved key of one kind (gemini, openai, anthropic), decrypted; null if none, or if it was saved under an old encryption key. */
export async function credentialSecret(tenantId: number, kind: 'gemini' | 'openai' | 'anthropic'): Promise<string | null> {
  const row = await queryOne<{ secret_enc: string }>(`SELECT secret_enc FROM wk_tenant_credentials WHERE tenant_id = $1 AND kind = $2 LIMIT 1`, [tenantId, kind]);
  if (!row) return null;
  try {
    return decryptSecret(row.secret_enc);
  } catch {
    return null; // the admin has to re-enter it
  }
}
