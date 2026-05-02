import { createClient } from "@supabase/supabase-js";
import { setChannelNamePrefixesFromDatabase } from "./assignmentMatch";

/** Load strip-prefixes from Supabase; empty or missing table → no stripping (admin configures). */
export async function fetchAndApplyChannelNamePrefixes(): Promise<void> {
  const url = import.meta.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    setChannelNamePrefixesFromDatabase(null);
    return;
  }
  const sb = createClient(url, key);
  const { data, error } = await sb
    .from("admin_channel_name_prefixes")
    .select("prefix")
    .order("sort_order", { ascending: true })
    .order("prefix", { ascending: true });
  if (error) {
    console.warn("[admin_channel_name_prefixes]", error.message);
    setChannelNamePrefixesFromDatabase(null);
    return;
  }
  const list = ((data ?? []) as { prefix: string }[])
    .map((r) => r.prefix)
    .filter((p) => typeof p === "string" && p.trim());
  setChannelNamePrefixesFromDatabase(list.length ? list : null);
}
