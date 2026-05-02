import { createClient } from "@supabase/supabase-js";
import { setCanonicalCountriesFromDatabase } from "./canonicalCountries";

/** Load `canonical_countries` from Supabase; if missing or empty, bundled defaults are used. */
export async function fetchAndApplyCanonicalCountries(): Promise<void> {
  const url = import.meta.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    setCanonicalCountriesFromDatabase(null);
    return;
  }
  const sb = createClient(url, key);
  const { data, error } = await sb
    .from("canonical_countries")
    .select("id, match_key, display_name")
    .order("sort_order", { ascending: true })
    .order("display_name", { ascending: true });
  if (error) {
    console.warn("[canonical_countries]", error.message);
    setCanonicalCountriesFromDatabase(null);
    return;
  }
  if (!data?.length) {
    setCanonicalCountriesFromDatabase(null);
    return;
  }
  setCanonicalCountriesFromDatabase(data);
}
