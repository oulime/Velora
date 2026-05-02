/**
 * Cloudflare Worker: POST multipart (field `file`, optional `file` + `packageId`) → R2.
 * Set secrets: UPLOAD_SECRET. Set var: PUBLIC_BASE_URL (no trailing slash), e.g. R2 public bucket URL.
 *
 * Deploy: npx wrangler deploy (from this directory)
 */

const MAX_BYTES = 2 * 1024 * 1024;

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function sanitizePackagePrefix(packageId: string): string {
  const t = packageId.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
  return t.length ? t.slice(0, 120) : "pkg";
}

interface Env {
  COVER_BUCKET: R2Bucket;
  UPLOAD_SECRET: string;
  /** Public base URL for objects, e.g. https://your-bucket.r2.dev or https://cdn.example.com */
  PUBLIC_BASE_URL: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const secret = env.UPLOAD_SECRET?.trim();
    if (!secret) {
      return json(500, { error: "Worker misconfigured: UPLOAD_SECRET" });
    }
    const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
    if (!base) {
      return json(500, { error: "Worker misconfigured: PUBLIC_BASE_URL" });
    }

    const auth = request.headers.get("Authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const headerKey = request.headers.get("X-Upload-Key")?.trim() ?? "";
    if (bearer !== secret && headerKey !== secret) {
      return json(401, { error: "Unauthorized" });
    }

    const ct = request.headers.get("Content-Type") ?? "";
    if (!ct.includes("multipart/form-data")) {
      return json(400, { error: "Expected multipart/form-data" });
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json(400, { error: "Invalid multipart body" });
    }

    const raw = form.get("file");
    if (!raw || typeof raw === "string") {
      return json(400, { error: "Missing file field" });
    }
    const file = raw as File;
    if (file.size > MAX_BYTES) {
      return json(413, { error: "File too large (max 2 MiB)" });
    }

    const packageId = String(form.get("packageId") ?? "").trim() || "pkg";
    const folder = sanitizePackagePrefix(packageId);
    const rawExt = (file.name.split(".").pop() || "jpg").toLowerCase();
    const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : "jpg";
    const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const contentType = file.type || (ext === "jpg" ? "image/jpeg" : `image/${ext}`);

    try {
      await env.COVER_BUCKET.put(key, file.stream(), {
        httpMetadata: { contentType },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "R2 put failed";
      return json(500, { error: msg });
    }

    const path = key.split("/").map(encodeURIComponent).join("/");
    const url = `${base}/${path}`;
    return json(200, { url });
  },
};
