import type { VercelRequest, VercelResponse } from "@vercel/node";
import { putCatalogToR2 } from "../r2CatalogCacheShared.js";

type WarmJob = {
  kind: "categories" | "live" | "vod" | "series";
  url: string;
};

type WarmResult = {
  kind: WarmJob["kind"];
  ok: boolean;
  status?: number;
  bytes?: number;
  cached?: boolean;
  error?: string;
};

export const config = {
  maxDuration: 300,
};

function envString(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function normalizeBase(raw: string): string {
  const t = raw.trim().replace(/\/+$/, "");
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
}

function warmBaseUrl(): string {
  return normalizeBase(
    envString("CATALOG_WARM_NODECAST_BASE") ||
      envString("VITE_NODECAST_API_BASE") ||
      envString("VITE_NODECAST_URL")
  );
}

function warmSourceId(): string {
  return (
    envString("CATALOG_WARM_XTREAM_SOURCE_ID") ||
    envString("VITE_NODECAST_XTREAM_SOURCE_ID") ||
    "2"
  );
}

function requestAuthorized(req: VercelRequest): boolean {
  if (req.headers["x-vercel-cron"] === "1") return true;
  const secret = envString("CATALOG_WARM_SECRET");
  if (!secret) return true;
  const auth = String(req.headers.authorization ?? "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const q = typeof req.query.secret === "string" ? req.query.secret.trim() : "";
  return bearer === secret || q === secret;
}

function extractTokenDeep(value: unknown, depth = 0): string | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") {
    const t = value.trim();
    return /^[A-Za-z0-9._~+/=-]{20,}$/.test(t) ? t : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = extractTokenDeep(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  for (const key of ["token", "access_token", "accessToken", "jwt", "bearer", "authToken"]) {
    const hit = extractTokenDeep(o[key], depth + 1);
    if (hit) return hit;
  }
  for (const key of ["data", "user", "session", "result"]) {
    const hit = extractTokenDeep(o[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

async function loginHeaders(base: string): Promise<Record<string, string>> {
  const username = envString("CATALOG_WARM_NODECAST_USERNAME") || envString("VITE_NODECAST_USERNAME");
  const password = envString("CATALOG_WARM_NODECAST_PASSWORD") || envString("VITE_NODECAST_PASSWORD");
  if (!username || !password) return {};
  const body = JSON.stringify({ username, password });
  for (const path of ["/api/auth/login", "/api/login", "/auth/login"]) {
    try {
      const r = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        },
        body,
      });
      if (!r.ok) continue;
      const text = await r.text();
      const parsed = text ? JSON.parse(text) : null;
      const token = extractTokenDeep(parsed);
      return token ? { Authorization: `Bearer ${token}` } : {};
    } catch {
      /* try next login path */
    }
  }
  return {};
}

function arrayFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const o = payload as Record<string, unknown>;
  for (const key of ["data", "items", "results", "categories", "response"]) {
    const v = o[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function categoryIdsFromPayload(payload: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of arrayFromPayload(payload)) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const id = String(o.category_id ?? o.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function maxCategories(): number {
  const raw = Number(envString("CATALOG_WARM_MAX_CATEGORIES"));
  if (!Number.isFinite(raw) || raw <= 0) return 500;
  return Math.min(Math.max(Math.round(raw), 1), 5000);
}

function concurrency(): number {
  const raw = Number(envString("CATALOG_WARM_CONCURRENCY"));
  if (!Number.isFinite(raw) || raw <= 0) return 5;
  return Math.min(Math.max(Math.round(raw), 1), 12);
}

async function fetchAndStore(job: WarmJob, headers: Record<string, string>): Promise<WarmResult> {
  try {
    const r = await fetch(job.url, {
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": "VLC/3.0.18 LibVLC/3.0.18",
        ...headers,
      },
    });
    const arr = Buffer.from(await r.arrayBuffer());
    if (!r.ok || arr.length === 0) {
      return { kind: job.kind, ok: false, status: r.status, bytes: arr.length };
    }
    const ct = r.headers.get("content-type")?.split(";")[0]?.trim() || "application/json";
    const cached = await putCatalogToR2(process.env, job.url, arr, ct, r.headers.get("etag"));
    return { kind: job.kind, ok: true, status: r.status, bytes: arr.length, cached };
  } catch (e) {
    return {
      kind: job.kind,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<WarmResult>): Promise<WarmResult[]> {
  const results: WarmResult[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency(), items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index]);
      }
    })
  );
  return results.filter(Boolean);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!["GET", "POST"].includes((req.method ?? "GET").toUpperCase())) {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!requestAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const base = warmBaseUrl();
  const sourceId = warmSourceId();
  if (!base || !sourceId) {
    res.status(400).json({ error: "Missing Nodecast warm base/source env" });
    return;
  }

  const startedAt = Date.now();
  const sid = encodeURIComponent(sourceId);
  const root = `${base}/api/proxy/xtream/${sid}`;
  const headers = await loginHeaders(base);
  const categoryJobs: WarmJob[] = [
    { kind: "categories", url: `${root}/live_categories` },
    { kind: "categories", url: `${root}/vod_categories` },
    { kind: "categories", url: `${root}/series_categories` },
  ];

  const categoryPayloads = await Promise.all(
    categoryJobs.map(async (job) => {
      const result = await fetchAndStore(job, headers);
      let ids: string[] = [];
      if (result.ok) {
        try {
          const r = await fetch(job.url, { headers: { accept: "application/json", ...headers } });
          ids = categoryIdsFromPayload(await r.json());
        } catch {
          ids = [];
        }
      }
      return { job, result, ids };
    })
  );

  const limit = maxCategories();
  const liveIds = categoryPayloads[0]?.ids.slice(0, limit) ?? [];
  const vodIds = categoryPayloads[1]?.ids.slice(0, limit) ?? [];
  const seriesIds = categoryPayloads[2]?.ids.slice(0, limit) ?? [];
  const sliceJobs: WarmJob[] = [
    ...liveIds.map((id) => ({ kind: "live" as const, url: `${root}/live_streams?category_id=${encodeURIComponent(id)}` })),
    ...vodIds.map((id) => ({ kind: "vod" as const, url: `${root}/vod_streams?category_id=${encodeURIComponent(id)}` })),
    ...seriesIds.map((id) => ({ kind: "series" as const, url: `${root}/series?category_id=${encodeURIComponent(id)}` })),
  ];

  const sliceResults = await runPool(sliceJobs, (job) => fetchAndStore(job, headers));
  const allResults = [...categoryPayloads.map((x) => x.result), ...sliceResults];
  const ok = allResults.filter((r) => r.ok).length;
  const cached = allResults.filter((r) => r.cached).length;
  const failed = allResults.length - ok;
  const bytes = allResults.reduce((sum, r) => sum + (r.bytes ?? 0), 0);

  res.status(failed ? 207 : 200).json({
    ok: failed === 0,
    sourceId,
    categories: { live: liveIds.length, vod: vodIds.length, series: seriesIds.length },
    requests: allResults.length,
    cached,
    failed,
    bytes,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    failures: allResults.filter((r) => !r.ok).slice(0, 20),
  });
}
