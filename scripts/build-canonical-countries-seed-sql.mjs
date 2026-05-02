/**
 * Writes `seed-canonical-countries.sql` at repo root from `src/canonicalCountries.ts` RAW only.
 * IPTV macros `|AR|`, `|AF|`, `|AS|`, `|EU|` are handled in the app (providerLayout), not in SQL.
 *
 * Usage: node scripts/build-canonical-countries-seed-sql.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function normalizeCountryKey(s) {
  return s
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRawFromCanonicalTs() {
  const p = path.join(root, "src", "canonicalCountries.ts");
  const s = readFileSync(p, "utf8");
  const m = s.match(/const RAW = `([\s\S]*?)`\.trim\(\)/);
  if (!m) throw new Error("RAW not found");
  return m[1].trim();
}

function rowsFromRaw(raw) {
  const seen = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const pipe = t.indexOf("|");
    if (pipe < 0) continue;
    const keyRaw = t.slice(0, pipe).trim();
    const display = t.slice(pipe + 1).trim();
    if (!keyRaw || !display) continue;
    const match_key = normalizeCountryKey(keyRaw);
    if (!match_key) continue;
    if (!seen.has(match_key)) seen.set(match_key, display);
  }
  return [...seen.entries()].map(([match_key, display_name], i) => ({
    match_key,
    display_name,
    sort_order: i,
  }));
}

function escSql(s) {
  return s.replace(/'/g, "''");
}

function main() {
  const raw = extractRawFromCanonicalTs();
  const rows = rowsFromRaw(raw);
  const vals = rows
    .map((r) => `('${escSql(r.match_key)}', '${escSql(r.display_name)}', ${r.sort_order})`)
    .join(",\n  ");

  const sql = `-- Paste in Supabase SQL Editor
-- Données = RAW dans src/canonicalCountries.ts (zones ar/af/as/eu = |AR|/|AF|/|AS|/|EU| après normalisation).
-- Tu peux stocker la clé comme |AR| ou ar (même normalisation → ar).

INSERT INTO public.canonical_countries (match_key, display_name, sort_order)
VALUES
  ${vals}
ON CONFLICT (match_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  sort_order = EXCLUDED.sort_order;
`;

  const out = path.join(root, "seed-canonical-countries.sql");
  writeFileSync(out, sql, "utf8");
  console.log(out, rows.length, "rows");
}

main();
