/**
 * Bouquets affichés pour tout pays : une entrée = nom catalogue Nodecast
 * (`category_name` → `AdminPackage.name`), ou id exact (UUID / category_id).
 * La liste persistante vit dans Supabase (`admin_global_package_allowlist`).
 */

function uniqNonEmptyStrings(xs: string[]): string[] {
  return [...new Set(xs.map((s) => s.trim()).filter((s) => s.length > 0))];
}

/** Split textarea / pasted list: newlines, commas, semicolons. */
export function parseGlobalAllowlistLinesFromText(raw: string): string[] {
  const parts = raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return uniqNonEmptyStrings(parts);
}

export function formatGlobalAllowlistLinesForTextarea(lines: string[]): string {
  return lines.join("\n");
}

export function normalizeGlobalAllowlistNameKey(s: string): string {
  try {
    return s
      .trim()
      .replace(/\s+/g, " ")
      .normalize("NFKC")
      .toLowerCase();
  } catch {
    return s.trim().replace(/\s+/g, " ").toLowerCase();
  }
}

export function uniqGlobalAllowlistLines(lines: string[]): string[] {
  return uniqNonEmptyStrings(lines);
}
