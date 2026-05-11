import type { SupabaseClient } from "@supabase/supabase-js";
import { parseGlobalAllowlistLinesFromText, uniqGlobalAllowlistLines } from "./globalPackageAllowlist";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

let cachedAllowlistLines: string[] = [];

export type GlobalPackageOpenConfirmUi = {
  message: string;
  yes_label: string;
  no_label: string;
};

function defaultOpenConfirmUi(): GlobalPackageOpenConfirmUi {
  return { message: "", yes_label: "Oui", no_label: "Non" };
}

let cachedOpenConfirmUi: GlobalPackageOpenConfirmUi = defaultOpenConfirmUi();

export function getGlobalPackageAllowlistLines(): string[] {
  return cachedAllowlistLines;
}

export function getGlobalPackageOpenConfirmUi(): GlobalPackageOpenConfirmUi {
  return { ...cachedOpenConfirmUi };
}

/** Clears allowlist lines + open-confirm UI (no Supabase / full hierarchy reset). */
export function clearGlobalPackageSupabaseCaches(): void {
  cachedAllowlistLines = [];
  cachedOpenConfirmUi = defaultOpenConfirmUi();
}

export async function fetchGlobalPackageAllowlistLines(sb: SupabaseClient | null): Promise<void> {
  if (!sb) {
    cachedAllowlistLines = [];
    return;
  }
  try {
    const { data, error } = await sb
      .from("admin_global_package_allowlist")
      .select("bouquet_name")
      .order("sort_order", { ascending: true })
      .order("bouquet_name", { ascending: true });
    if (error) throw error;
    cachedAllowlistLines = uniqGlobalAllowlistLines(
      (data ?? []).map((r) => String((r as { bouquet_name: unknown }).bouquet_name ?? ""))
    );
  } catch (e) {
    console.warn("[admin_global_package_allowlist]", e instanceof Error ? e.message : e);
    cachedAllowlistLines = [];
  }
}

export async function fetchGlobalPackageOpenConfirmUi(sb: SupabaseClient | null): Promise<void> {
  if (!sb) {
    cachedOpenConfirmUi = defaultOpenConfirmUi();
    return;
  }
  try {
    const { data, error } = await sb
      .from("admin_global_package_open_confirm")
      .select("message, yes_label, no_label")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw error;
    if (data && typeof data === "object") {
      const o = data as Record<string, unknown>;
      cachedOpenConfirmUi = {
        message: typeof o.message === "string" ? o.message : "",
        yes_label: typeof o.yes_label === "string" && o.yes_label.trim() ? o.yes_label : "Oui",
        no_label: typeof o.no_label === "string" && o.no_label.trim() ? o.no_label : "Non",
      };
    } else {
      cachedOpenConfirmUi = defaultOpenConfirmUi();
    }
  } catch (e) {
    console.warn("[admin_global_package_open_confirm]", e instanceof Error ? e.message : e);
    cachedOpenConfirmUi = defaultOpenConfirmUi();
  }
}

/** Replace all rows (admin settings save). Updates in-memory cache on success. */
export async function replaceGlobalPackageAllowlistInDb(
  sb: SupabaseClient,
  rawText: string
): Promise<{ error?: string }> {
  const cleaned = parseGlobalAllowlistLinesFromText(rawText);
  const { error: delErr } = await sb
    .from("admin_global_package_allowlist")
    .delete()
    .neq("id", NIL_UUID);
  if (delErr) return { error: delErr.message };
  if (cleaned.length === 0) {
    cachedAllowlistLines = [];
    return {};
  }
  const rows = cleaned.map((bouquet_name, sort_order) => ({ bouquet_name, sort_order }));
  const { error: insErr } = await sb.from("admin_global_package_allowlist").insert(rows);
  if (insErr) return { error: insErr.message };
  cachedAllowlistLines = cleaned;
  return {};
}

export async function upsertGlobalPackageOpenConfirmUi(
  sb: SupabaseClient,
  ui: GlobalPackageOpenConfirmUi
): Promise<{ error?: string }> {
  const row = {
    id: 1 as const,
    message: ui.message.trim(),
    yes_label: (ui.yes_label ?? "Oui").trim() || "Oui",
    no_label: (ui.no_label ?? "Non").trim() || "Non",
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("admin_global_package_open_confirm").upsert(row, { onConflict: "id" });
  if (error) return { error: error.message };
  cachedOpenConfirmUi = {
    message: row.message,
    yes_label: row.yes_label,
    no_label: row.no_label,
  };
  return {};
}
