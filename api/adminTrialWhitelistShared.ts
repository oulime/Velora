/**
 * GET/POST/DELETE /api/admin/trial-whitelist — Supabase service role only (server).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyAdminAccess } from "./adminAuth.js";
import { canonicalIpForWhitelist, isValidIpAddress } from "./ipAddressValidate.js";
import {
  createSupabaseAdminClient,
  detectClientIp,
  TrialConfigurationError,
} from "./trialShared.js";

export type TrialWhitelistItemJson = {
  ipAddress: string;
  label: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch {
    return null;
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function rowToJson(r: {
  ip_address: string;
  label: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}): TrialWhitelistItemJson {
  return {
    ipAddress: r.ip_address,
    label: r.label,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function handleAdminTrialWhitelist(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!verifyAdminAccess(req, env)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const method = (req.method ?? "GET").toUpperCase();

  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Velora-Admin-Access, X-Admin-Access");
    res.end();
    return;
  }

  try {
    const sb = createSupabaseAdminClient(env);
    if (method === "GET") {
      const { data, error } = await sb
        .from("trial_ip_whitelist")
        .select("ip_address, label, notes, created_at, updated_at")
        .order("created_at", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as {
        ip_address: string;
        label: string | null;
        notes: string | null;
        created_at: string;
        updated_at: string;
      }[];
      sendJson(res, 200, {
        items: rows.map(rowToJson),
      });
      return;
    }

    if (method === "POST") {
      const raw = await readJsonBody(req);
      if (!raw || typeof raw !== "object") {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const o = raw as Record<string, unknown>;
      const ipRaw = typeof o.ipAddress === "string" ? o.ipAddress : "";
      const ip = canonicalIpForWhitelist(ipRaw);
      if (!isValidIpAddress(ip)) {
        sendJson(res, 400, { error: "Adresse IP invalide." });
        return;
      }
      const label =
        typeof o.label === "string" && o.label.trim()
          ? o.label.trim()
          : null;
      const notes =
        typeof o.notes === "string" && o.notes.trim()
          ? o.notes.trim()
          : null;

      const { data: existing } = await sb
        .from("trial_ip_whitelist")
        .select("ip_address")
        .eq("ip_address", ip)
        .maybeSingle();

      const nowIso = new Date().toISOString();
      if (existing) {
        const { data: upd, error } = await sb
          .from("trial_ip_whitelist")
          .update({
            label,
            notes,
            updated_at: nowIso,
          })
          .eq("ip_address", ip)
          .select("ip_address, label, notes, created_at, updated_at")
          .single();
        if (error) throw error;
        sendJson(res, 200, { item: rowToJson(upd as Parameters<typeof rowToJson>[0]) });
        return;
      }

      const { data: ins, error } = await sb
        .from("trial_ip_whitelist")
        .insert({
          ip_address: ip,
          label,
          notes,
        })
        .select("ip_address, label, notes, created_at, updated_at")
        .single();
      if (error) throw error;
      sendJson(res, 200, { item: rowToJson(ins as Parameters<typeof rowToJson>[0]) });
      return;
    }

    if (method === "DELETE") {
      const raw = await readJsonBody(req);
      if (!raw || typeof raw !== "object") {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const o = raw as Record<string, unknown>;
      const ipRaw = typeof o.ipAddress === "string" ? o.ipAddress : "";
      const ip = canonicalIpForWhitelist(ipRaw);
      if (!isValidIpAddress(ip)) {
        sendJson(res, 400, { error: "Adresse IP invalide." });
        return;
      }
      const { error } = await sb
        .from("trial_ip_whitelist")
        .delete()
        .eq("ip_address", ip);
      if (error) throw error;
      sendJson(res, 200, { success: true });
      return;
    }

    sendJson(res, 405, { error: "Method Not Allowed" });
  } catch (e) {
    if (e instanceof TrialConfigurationError) {
      sendJson(res, 503, { error: e.message, code: "trial_config" });
      return;
    }
    sendJson(res, 500, {
      error: e instanceof Error ? e.message : "Server error",
    });
  }
}

export async function handleAdminMyIp(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!verifyAdminAccess(req, env)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }
  try {
    const ipAddress = detectClientIp(req);
    sendJson(res, 200, { ipAddress });
  } catch (e) {
    sendJson(res, 500, {
      error: e instanceof Error ? e.message : "Server error",
    });
  }
}
