/**
 * Seed `canonical_countries` from the same `RAW` list as `src/canonicalCountries.ts`.
 *
 * Usage (from project root):
 *   node scripts/seed-canonical-countries.mjs
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY from `.env.local` then `.env`.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadDotEnv() {
  for (const name of [".env.local", ".env"]) {
    const p = path.join(root, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env) || process.env[k] === "") process.env[k] = v;
    }
  }
}

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
  if (!m) throw new Error("Could not find const RAW = `...` in src/canonicalCountries.ts");
  return m[1].trim();
}

function rowsFromRaw(raw) {
  const seen = new Map();
  for (const line of raw.split("\n")) {
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

async function main() {
  loadDotEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env / .env.local");
    process.exit(1);
  }

  const raw = extractRawFromCanonicalTs();
  const rows = rowsFromRaw(raw);
  console.log(`Parsed ${rows.length} unique match_key rows from canonicalCountries.ts RAW.`);

  const supabase = createClient(url, key);
  const chunk = 200;
  let ok = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const { error } = await supabase.from("canonical_countries").upsert(part, {
      onConflict: "match_key",
      ignoreDuplicates: false,
    });
    if (error) {
      console.error("Upsert error:", error.message);
      process.exit(1);
    }
    ok += part.length;
    console.log(`Upserted ${ok}/${rows.length}`);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
