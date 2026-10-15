import dns from 'dns/promises';
import net from 'net';

/**
 * Guards a URL a tenant admin typed in (their Jira or ServiceNow address) before the SERVER calls it.
 * Without this, "ticket system" could be pointed at localhost, the cloud metadata address or an internal
 * service, and the portal would fetch it for them. Must be https, no embedded credentials, and every
 * address the name resolves to must be public. Redirects are refused by the callers.
 */

export class UnsafeUrlError extends Error {}

/** True for loopback, private, link-local, CGNAT, unspecified and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v) || v.startsWith('ff');
  }
  return true; // not an address at all: refuse
}

export async function assertSafeHttpsUrl(raw: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('That is not a valid URL');
  }
  if (!allowPrivate && url.protocol !== 'https:') throw new UnsafeUrlError('The URL must start with https://');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UnsafeUrlError('The URL must start with https://');
  if (url.username || url.password) throw new UnsafeUrlError('Do not put a user name or password in the URL');
  if (allowPrivate) return url;
  if (url.port && url.port !== '443') throw new UnsafeUrlError('Only the standard https port is allowed');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new UnsafeUrlError('That address could not be found');
  if (addresses.some(isPrivateAddress)) throw new UnsafeUrlError('That address is not on the public internet');
  return url;
}
