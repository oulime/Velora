/**
 * Server-only trial helpers (Supabase RPC + IP detection).
 * Uses SUPABASE_SERVICE_ROLE_KEY (required) and project URL from SUPABASE_URL with
 * fallback to NEXT_PUBLIC_SUPABASE_URL only. Never use anon/publishable keys server-side.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Fixed server-side increment; frontend cannot choose duration. */
export const TRIAL_INCREMENT_SECONDS = 5;

/** Returned when SUPABASE_SERVICE_ROLE_KEY is unset (exact contract for API clients). */
export const TRIAL_ERROR_MISSING_SERVICE_ROLE_KEY =
  "Missing SUPABASE_SERVICE_ROLE_KEY. Add it to .env.local for local dev and to deployment environment variables for production.";

export const TRIAL_ERROR_MISSING_SUPABASE_URL =
  "Missing Supabase project URL. Set SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL in .env.local for local dev and in deployment environment variables for production.";

/** Configuration / env errors only — not RPC failures. */
export class TrialConfigurationError extends Error {
  readonly code = "trial_config" as const;
  constructor(message: string) {
    super(message);
    this.name = "TrialConfigurationError";
  }
}

export function getSupabaseProjectUrl(env: NodeJS.ProcessEnv): string {
  const primary = env.SUPABASE_URL?.trim();
  if (primary) return primary;
  return env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
}

function headerFirst(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (raw == null) return "";
  const s = Array.isArray(raw) ? raw[0] : raw;
  return typeof s === "string" ? s.trim() : "";
}

function normalizeIp(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("::ffff:")) return t.slice(7);
  return t;
}

function looksLikeIp(s: string): boolean {
  if (!s) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return true;
  if (s.includes(":")) return true;
  return false;
}

export function detectClientIp(req: IncomingMessage): string {
  const cf = normalizeIp(headerFirst(req, "cf-connecting-ip"));
  if (cf && looksLikeIp(cf)) return cf;

  const xff = headerFirst(req, "x-forwarded-for");
  if (xff) {
    const first = normalizeIp(xff.split(",")[0] ?? "");
    if (first && looksLikeIp(first)) return first;
  }

  const xr = normalizeIp(headerFirst(req, "x-real-ip"));
  if (xr && looksLikeIp(xr)) return xr;

  const sock: Socket | undefined =
    req.socket ??
    (req as IncomingMessage & { connection?: Socket }).connection;
  const ra = sock?.remoteAddress;
  if (ra && looksLikeIp(normalizeIp(ra))) return normalizeIp(ra);

  return "0.0.0.0";
}

export function getTrialLimitSeconds(env: NodeJS.ProcessEnv): number {
  const raw = env.TRIAL_LIMIT_SECONDS?.trim();
  if (!raw) return 60;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return Math.floor(n);
}

export function getCheckoutUrl(env: NodeJS.ProcessEnv): string {
  const u = env.CHECKOUT_URL?.trim();
  return u && u.length > 0 ? u : "/checkout";
}

export function createSupabaseAdminClient(
  env: NodeJS.ProcessEnv = process.env
): SupabaseClient {
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) {
    throw new TrialConfigurationError(TRIAL_ERROR_MISSING_SERVICE_ROLE_KEY);
  }
  const url = getSupabaseProjectUrl(env);
  if (!url) {
    throw new TrialConfigurationError(TRIAL_ERROR_MISSING_SUPABASE_URL);
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function getTrialUsageForIp(
  ip: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const sb = createSupabaseAdminClient(env);
  const { data, error } = await sb.rpc("get_trial_usage", { client_ip: ip });
  if (error) throw error;
  const n = typeof data === "number" ? data : Number(data);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

export async function incrementTrialUsageForIp(
  ip: string,
  seconds: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const sb = createSupabaseAdminClient(env);
  const incSeconds = Math.max(1, Math.floor(seconds));
  const { data, error } = await sb.rpc("increment_trial_usage", {
    client_ip: ip,
    inc_seconds: incSeconds,
  });
  if (error) throw error;
  const n = typeof data === "number" ? data : Number(data);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

export async function isTrialIpWhitelisted(
  ip: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  try {
    const sb = createSupabaseAdminClient(env);
    const { data, error } = await sb.rpc("is_trial_ip_whitelisted", {
      client_ip: ip,
    });
    if (error) {
      console.warn("[trial] is_trial_ip_whitelisted:", error.message);
      return false;
    }
    return data === true;
  } catch (e) {
    console.warn(
      "[trial] whitelist check failed:",
      e instanceof Error ? e.message : e
    );
    return false;
  }
}

export type TrialApiPayload = {
  allowed: boolean;
  whitelisted?: boolean;
  secondsUsed: number;
  secondsRemaining: number;
  limitSeconds: number;
  checkoutUrl: string;
};

export function buildWhitelistedTrialResponse(
  env: NodeJS.ProcessEnv = process.env
): TrialApiPayload {
  const limit = getTrialLimitSeconds(env);
  return {
    allowed: true,
    whitelisted: true,
    secondsUsed: 0,
    secondsRemaining: limit,
    limitSeconds: limit,
    checkoutUrl: getCheckoutUrl(env),
  };
}

export function buildTrialResponse(
  secondsUsed: number,
  env: NodeJS.ProcessEnv = process.env
): TrialApiPayload {
  const limit = getTrialLimitSeconds(env);
  const clamped = Math.max(0, Math.floor(secondsUsed));
  const remaining = Math.max(0, limit - clamped);
  return {
    allowed: clamped < limit,
    secondsUsed: clamped,
    secondsRemaining: remaining,
    limitSeconds: limit,
    checkoutUrl: getCheckoutUrl(env),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendConfigurationError(res: ServerResponse, message: string): void {
  sendJson(res, 503, { error: message, code: "trial_config" });
}

function sendRpcOrUnknownError(
  res: ServerResponse,
  e: unknown
): void {
  sendJson(res, 500, {
    error: e instanceof Error ? e.message : "Server error",
  });
}

/**
 * GET /api/trial-status — returns 200 only when env is valid and RPC succeeds.
 */
export async function handleTrialStatus(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }
  try {
    const ip = detectClientIp(req);
    if (await isTrialIpWhitelisted(ip, env)) {
      sendJson(res, 200, buildWhitelistedTrialResponse(env));
      return;
    }
    const used = await getTrialUsageForIp(ip, env);
    sendJson(res, 200, buildTrialResponse(used, env));
  } catch (e) {
    if (e instanceof TrialConfigurationError) {
      sendConfigurationError(res, e.message);
      return;
    }
    sendRpcOrUnknownError(res, e);
  }
}

/**
 * POST /api/trial-increment — returns 200 only when env is valid and RPC succeeds.
 */
export async function handleTrialIncrement(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }
  try {
    const ip = detectClientIp(req);
    if (await isTrialIpWhitelisted(ip, env)) {
      sendJson(res, 200, buildWhitelistedTrialResponse(env));
      return;
    }
    const limit = getTrialLimitSeconds(env);
    const used = await getTrialUsageForIp(ip, env);
    if (used >= limit) {
      sendJson(res, 200, buildTrialResponse(used, env));
      return;
    }
    const newUsed = await incrementTrialUsageForIp(
      ip,
      TRIAL_INCREMENT_SECONDS,
      env
    );
    sendJson(res, 200, buildTrialResponse(newUsed, env));
  } catch (e) {
    if (e instanceof TrialConfigurationError) {
      sendConfigurationError(res, e.message);
      return;
    }
    sendRpcOrUnknownError(res, e);
  }
}
