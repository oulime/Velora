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

async function uploadPackageCoverToCloudflare(
  packageId: string,
  file: File
): Promise<{ url: string } | { error: string } | null> {
  const endpoint = (import.meta.env.VITE_CLOUDFLARE_COVER_UPLOAD_URL as string | undefined)?.trim();
  if (!endpoint) return null;
  const secret = (import.meta.env.VITE_CLOUDFLARE_COVER_UPLOAD_SECRET as string | undefined)?.trim();
  const fd = new FormData();
  fd.set("file", file);
  fd.set("packageId", packageId);
  const headers: HeadersInit = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  let res: Response;
  try {
    res = await fetch(endpoint, { method: "POST", body: fd, headers });
  } catch {
    return { error: "Réseau indisponible (upload Cloudflare)." };
  }
  const text = await res.text();
  let parsed: { url?: string; error?: string };
  try {
    parsed = (text ? JSON.parse(text) : {}) as { url?: string; error?: string };
  } catch {
    return { error: res.ok ? "Réponse serveur invalide." : text || `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { error: parsed.error || text || `Échec upload (${res.status}).` };
  }
  const url = parsed.url?.trim();
  if (!url) return { error: parsed.error || "URL manquante dans la réponse." };
  return { url };
}

/** Upload a cover file; returns public URL or an error message. */
export async function uploadPackageCoverFile(
  sb: SupabaseClient,
  packageId: string,
  file: File
): Promise<{ url: string } | { error: string }> {
  if (file.size > MAX_COVER_BYTES) {
    return { error: "Image trop volumineuse (max 2 Mo)." };
  }
  const cf = await uploadPackageCoverToCloudflare(packageId, file);
  if (cf) return cf;

  const rawExt = (file.name.split(".").pop() || "jpg").toLowerCase();
  const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : "jpg";
  const folder = sanitizePackageCoverStoragePrefix(packageId);
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const { error } = await sb.storage.from(PACKAGE_COVERS_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type || `image/${ext === "jpg" ? "jpeg" : ext}`,
  });
  if (error) return { error: error.message };
  const { data } = sb.storage.from(PACKAGE_COVERS_BUCKET).getPublicUrl(path);
  const url = data.publicUrl;
  if (!url) return { error: "URL publique indisponible." };
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
