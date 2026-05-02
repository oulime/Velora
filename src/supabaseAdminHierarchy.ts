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
    .select("id, country_id, name, theme_bg, theme_surface, theme_primary, theme_glow, theme_back")
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(normalizePackage).filter((p): p is AdminPackage => p != null);
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
