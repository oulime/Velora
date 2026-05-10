/**
 * Trimmed exact-match IPs for whitelist storage and lookup (IPv4 + IPv6).
 */
import { isIPv4, isIPv6 } from "node:net";

export function isValidIpAddress(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s.startsWith("::ffff:")) {
    const tail = s.slice(7);
    if (isIPv4(tail)) return true;
  }
  return isIPv4(s) || isIPv6(s);
}

/** Align with server client IP normalization where possible. */
export function canonicalIpForWhitelist(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("::ffff:")) {
    const tail = s.slice(7);
    if (isIPv4(tail)) return tail;
  }
  if (isIPv4(s)) return s;
  if (isIPv6(s)) return s.toLowerCase();
  return s.trim();
}
