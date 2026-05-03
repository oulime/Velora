/**
 * Server-only: multipart package cover upload → Cloudflare R2 (S3 API).
 * Used by Vite dev/preview middleware and Vercel `api/r2-package-cover.ts`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import busboy from "busboy";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const MAX_BYTES = 2 * 1024 * 1024;
const ROUTE_PREFIX = "/api/r2-package-cover";

function corsJsonHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Upload-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function sanitizePackagePrefix(packageId: string): string {
  const t = packageId.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
  return t.length ? t.slice(0, 120) : "pkg";
}

function readEnv(env: NodeJS.ProcessEnv): {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBase: string;
  uploadSecrets: string[];
} | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.R2_BUCKET_NAME?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;

  const explicit = env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  const publicBase =
    explicit || `https://${bucket}.${accountId}.r2.dev`;

  const uploadSecrets: string[] = [];
  const bearer = env.VITE_CLOUDFLARE_COVER_UPLOAD_SECRET?.trim();
  if (bearer) uploadSecrets.push(bearer);

  return { accountId, accessKeyId, secretAccessKey, bucket, publicBase, uploadSecrets };
}

function s3Client(cfg: NonNullable<ReturnType<typeof readEnv>>): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: true,
  });
}

function authorize(req: IncomingMessage, uploadSecrets: string[]): boolean {
  if (!uploadSecrets.length) return true;
  const auth = req.headers.authorization ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const headerKey = (req.headers["x-upload-key"] as string | undefined)?.trim() ?? "";
  return uploadSecrets.some((s) => s === bearer || s === headerKey);
}

function json(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = corsJsonHeaders()
): void {
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/** True if this request targets the R2 package-cover route (path + optional query). */
export function isR2PackageCoverRoute(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0] ?? "";
  return path === ROUTE_PREFIX;
}

export async function handleR2PackageCoverRoute(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsJsonHeaders());
    res.end();
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  const cfg = readEnv(env);
  if (!cfg) {
    json(res, 503, { error: "R2 is not configured (set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME)." });
    return;
  }

  if (!authorize(req, cfg.uploadSecrets)) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  const ct = req.headers["content-type"] ?? "";
  if (typeof ct !== "string" || !ct.includes("multipart/form-data")) {
    json(res, 400, { error: "Expected multipart/form-data" });
    return;
  }

  const parsed = await parseMultipart(req, ct);
  if ("error" in parsed) {
    json(res, parsed.status, { error: parsed.error });
    return;
  }

  const { fileBuffer, fileName, mime, packageId } = parsed;
  const rawExt = (fileName.split(".").pop() || "jpg").toLowerCase();
  const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : "jpg";
  const folder = sanitizePackagePrefix(packageId);
  const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const contentType = mime || (ext === "jpg" ? "image/jpeg" : `image/${ext}`);

  const client = s3Client(cfg);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
      })
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "R2 put failed";
    json(res, 500, { error: msg });
    return;
  }

  const pathEnc = key.split("/").map(encodeURIComponent).join("/");
  const url = `${cfg.publicBase}/${pathEnc}`;
  json(res, 200, { url });
}

type ParseOk = {
  fileBuffer: Buffer;
  fileName: string;
  mime: string;
  packageId: string;
};

type ParseErr = { error: string; status: number };

function parseMultipart(req: IncomingMessage, contentType: string): Promise<ParseOk | ParseErr> {
  return new Promise((resolve) => {
    const bb = busboy({
      headers: { "content-type": contentType },
      limits: { fileSize: MAX_BYTES },
    });

    let fileBuffer: Buffer | null = null;
    let fileName = "";
    let mime = "";
    let packageId = "";
    let fileTooBig = false;

    bb.on("field", (name, val) => {
      if (name === "packageId") packageId = String(val).trim();
    });

    bb.on("file", (_name, file, info) => {
      fileName = info.filename || "upload";
      mime = info.mimeType || "";
      const chunks: Buffer[] = [];
      file.on("data", (d: Buffer) => {
        chunks.push(d);
      });
      file.on("limit", () => {
        fileTooBig = true;
      });
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    bb.on("error", (err: Error) => {
      resolve({ error: err.message || "Multipart parse error", status: 400 });
    });

    bb.on("finish", () => {
      if (fileTooBig) {
        resolve({ error: "Image trop volumineuse (max 2 Mo).", status: 413 });
        return;
      }
      if (!fileBuffer?.length) {
        resolve({ error: "Missing file field", status: 400 });
        return;
      }
      const pid = packageId || "pkg";
      resolve({
        fileBuffer,
        fileName,
        mime,
        packageId: pid,
      });
    });

    req.pipe(bb);
  });
}
