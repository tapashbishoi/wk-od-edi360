/**
 * Password rules for members setting their own password. Length does the work
 * (a long passphrase beats a short "complex" one); the other checks only stop
 * the obviously bad choices.
 */

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128; // bcrypt only reads the first 72 bytes; this keeps absurd inputs out

/** Returns an error message, or null when the password is acceptable. */
export function validatePassword(password: unknown, email?: string): string | null {
  if (typeof password !== 'string') return 'A password is required';
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  if (/^(.)\1+$/.test(password)) return 'Password cannot be a single repeated character';
  if (email && password.toLowerCase() === email.toLowerCase()) return 'Password cannot be your email address';
  return null;
}
