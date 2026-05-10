/**
 * Optional shared secret for server-side admin routes (whitelist, my-ip).
 * When unset, routes stay open for local dev (same idea as empty VITE_ADMIN_ACCESS_KEY).
 * Set ADMIN_ACCESS_KEY or VELORA_ADMIN_ACCESS_KEY in production.
 */
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

function headerFirst(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (raw == null) return "";
  const s = Array.isArray(raw) ? raw[0] : raw;
  return typeof s === "string" ? s.trim() : "";
}

function bearerToken(req: IncomingMessage): string {
  const auth = headerFirst(req, "authorization");
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m?.[1]?.trim() ?? "";
}

export function getAdminAccessKey(env: NodeJS.ProcessEnv = process.env): string {
  const a = env.ADMIN_ACCESS_KEY?.trim();
  if (a) return a;
  const b = env.VELORA_ADMIN_ACCESS_KEY?.trim();
  if (b) return b;
  return env.VITE_ADMIN_ACCESS_KEY?.trim() ?? "";
}

export function verifyAdminAccess(
  req: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const configured = getAdminAccessKey(env);
  if (!configured) return true;
  const sent =
    headerFirst(req, "x-velora-admin-access") ||
    headerFirst(req, "x-admin-access") ||
    bearerToken(req);
  if (!sent) return false;
  try {
    const a = Buffer.from(configured, "utf8");
    const b = Buffer.from(sent, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
