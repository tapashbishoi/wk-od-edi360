import { describe, it, expect } from 'vitest';
import { validatePassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from './password.js';

describe('validatePassword', () => {
  it('accepts a long passphrase', () => {
    expect(validatePassword('correct horse battery staple')).toBeNull();
  });

  it('rejects short passwords', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toMatch(/at least/);
    expect(validatePassword('abcdefghij')).toBeNull(); // exactly the minimum
  });

  it('rejects absurdly long input', () => {
    expect(validatePassword('a1'.repeat(MAX_PASSWORD_LENGTH))).toMatch(/at most/);
  });

  it('rejects one repeated character and the email address itself', () => {
    expect(validatePassword('aaaaaaaaaaaa')).toMatch(/repeated/);
    expect(validatePassword('Jane@Customer.com', 'jane@customer.com')).toMatch(/email/);
  });

  it('rejects non-strings', () => {
    expect(validatePassword(undefined)).toMatch(/required/);
    expect(validatePassword(1234567890123)).toMatch(/required/);
  });
});
