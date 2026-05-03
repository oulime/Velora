import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { normalizeCountryKey } from "./canonicalCountries";
import type { AdminCountry, AdminPackage } from "./adminHierarchyConfig";
import { normalizePackage } from "./adminHierarchyConfig";

export function getSupabaseClient(): SupabaseClient | null {
  const url = import.meta.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
  const key = import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  if (!url?.trim() || !key?.trim()) return null;
  return createClient(url.trim(), key.trim());
}

export async function fetchDbAdminCountries(sb: SupabaseClient): Promise<AdminCountry[]> {
  const { data, error } = await sb.from("admin_countries").select("id, name").order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []) as AdminCountry[];
}

export async function fetchDbAdminPackages(sb: SupabaseClient): Promise<AdminPackage[]> {
  const { data, error } = await sb
    .from("admin_packages")
    .select(
      "id, country_id, name, cover_url, theme_bg, theme_surface, theme_primary, theme_glow, theme_back"
    )
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(normalizePackage).filter((p): p is AdminPackage => p != null);
}

/** Public bucket for package card images (create in Supabase Dashboard → Storage). */
export const PACKAGE_COVERS_BUCKET = "package-covers";

const MAX_COVER_BYTES = 2 * 1024 * 1024;

/** Safe folder name under Storage (provider ids, `velagg:…`, UUIDs). */
export function sanitizePackageCoverStoragePrefix(packageId: string): string {
  const t = packageId.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
  return t.length ? t.slice(0, 120) : "pkg";
}

function truthyEnvFlag(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** Set `VITE_DEBUG_PACKAGE_COVER=1` to log cover upload + grid image diagnostics. */
export function isPackageCoverDebugEnabled(): boolean {
  return truthyEnvFlag(import.meta.env.VITE_DEBUG_PACKAGE_COVER);
}

function coverLog(msg: string, extra?: Record<string, unknown>): void {
  if (!isPackageCoverDebugEnabled()) return;
  if (extra) console.log("[package-cover]", msg, extra);
  else console.log("[package-cover]", msg);
}

async function uploadPackageCoverToCloudflare(
  packageId: string,
  file: File
): Promise<{ url: string } | { error: string } | null> {
  const endpoint = (import.meta.env.VITE_CLOUDFLARE_COVER_UPLOAD_URL as string | undefined)?.trim();
  if (!endpoint) {
    coverLog("skip Worker upload (no VITE_CLOUDFLARE_COVER_UPLOAD_URL)");
    return null;
  }
  coverLog("try Worker upload", { packageId, endpoint, fileBytes: file.size });
  const secret = (import.meta.env.VITE_CLOUDFLARE_COVER_UPLOAD_SECRET as string | undefined)?.trim();
  const fd = new FormData();
  fd.set("file", file);
  fd.set("packageId", packageId);
  const headers: HeadersInit = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  let res: Response;
  try {
    res = await fetch(endpoint, { method: "POST", body: fd, headers });
  } catch (e) {
    coverLog("Worker upload network error", { message: e instanceof Error ? e.message : String(e) });
    return { error: "Réseau indisponible (upload Cloudflare)." };
  }
  const text = await res.text();
  let parsed: { url?: string; error?: string };
  try {
    parsed = (text ? JSON.parse(text) : {}) as { url?: string; error?: string };
  } catch {
    coverLog("Worker invalid JSON", { status: res.status, textPreview: text.slice(0, 200) });
    return { error: res.ok ? "Réponse serveur invalide." : text || `HTTP ${res.status}` };
  }
  if (!res.ok) {
    coverLog("Worker upload failed", { status: res.status, error: parsed.error, textPreview: text.slice(0, 200) });
    return { error: parsed.error || text || `Échec upload (${res.status}).` };
  }
  const url = parsed.url?.trim();
  if (!url) return { error: parsed.error || "URL manquante dans la réponse." };
  coverLog("Worker upload ok", { url });
  return { url };
}

/** Same-origin `/api/r2-package-cover` (Vite dev / Vercel) when `VITE_R2_COVER_UPLOAD` is set; uses R2_* on the server. */
async function uploadPackageCoverToR2LocalApi(
  packageId: string,
  file: File
): Promise<{ url: string } | { error: string } | null> {
  if (!truthyEnvFlag(import.meta.env.VITE_R2_COVER_UPLOAD)) {
    coverLog("skip R2 API upload (VITE_R2_COVER_UPLOAD not truthy)");
    return null;
  }
  coverLog("try /api/r2-package-cover", { packageId, fileBytes: file.size });
  const secret = (import.meta.env.VITE_CLOUDFLARE_COVER_UPLOAD_SECRET as string | undefined)?.trim();
  const fd = new FormData();
  fd.set("file", file);
  fd.set("packageId", packageId);
  const headers: HeadersInit = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  let res: Response;
  try {
    res = await fetch("/api/r2-package-cover", { method: "POST", body: fd, headers });
  } catch (e) {
    coverLog("R2 API upload network error", { message: e instanceof Error ? e.message : String(e) });
    return { error: "Réseau indisponible (upload R2)." };
  }
  const text = await res.text();
  let parsed: { url?: string; error?: string };
  try {
    parsed = (text ? JSON.parse(text) : {}) as { url?: string; error?: string };
  } catch {
    coverLog("R2 API invalid JSON", { status: res.status, textPreview: text.slice(0, 200) });
    return { error: res.ok ? "Réponse serveur invalide." : text || `HTTP ${res.status}` };
  }
  if (!res.ok) {
    coverLog("R2 API upload failed", { status: res.status, error: parsed.error, textPreview: text.slice(0, 200) });
    return { error: parsed.error || text || `Échec upload (${res.status}).` };
  }
  const url = parsed.url?.trim();
  if (!url) return { error: parsed.error || "URL manquante dans la réponse." };
  coverLog("R2 API upload ok", { url });
  return { url };
}

/** Upload a cover file; returns public URL or an error message. */
export async function uploadPackageCoverFile(
  sb: SupabaseClient,
  packageId: string,
  file: File
): Promise<{ url: string } | { error: string }> {
  coverLog("uploadPackageCoverFile start", { packageId, fileBytes: file.size, name: file.name });
  if (file.size > MAX_COVER_BYTES) {
    return { error: "Image trop volumineuse (max 2 Mo)." };
  }
  const cf = await uploadPackageCoverToCloudflare(packageId, file);
  if (cf) return cf;

  const r2 = await uploadPackageCoverToR2LocalApi(packageId, file);
  if (r2) return r2;

  coverLog("try Supabase Storage", { bucket: PACKAGE_COVERS_BUCKET, packageId });
  const rawExt = (file.name.split(".").pop() || "jpg").toLowerCase();
  const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : "jpg";
  const folder = sanitizePackageCoverStoragePrefix(packageId);
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const { error } = await sb.storage.from(PACKAGE_COVERS_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type || `image/${ext === "jpg" ? "jpeg" : ext}`,
  });
  if (error) {
    coverLog("Supabase Storage upload failed", { message: error.message });
    return { error: error.message };
  }
  const { data } = sb.storage.from(PACKAGE_COVERS_BUCKET).getPublicUrl(path);
  const url = data.publicUrl;
  if (!url) return { error: "URL publique indisponible." };
  coverLog("Supabase Storage upload ok", { url });
  return { url };
}

/** Match Supabase `admin_countries.id` from the provider UI country display name. */
export function matchDbCountryIdByDisplayName(
  providerCountryName: string,
  dbCountries: AdminCountry[]
): string | null {
  const n = normalizeCountryKey(providerCountryName);
  if (!n) return null;
  const hit = dbCountries.find((c) => normalizeCountryKey(c.name) === n);
  return hit?.id ?? null;
}

/** UUID v4 shape — used for Supabase package ids, country ids, etc. */
export function isLikelyUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id.trim());
}

/** @deprecated use isLikelyUuid */
export function isLikelyUuidPackageId(id: string): boolean {
  return isLikelyUuid(id);
}
