import { createClient } from "@supabase/supabase-js";
import { setChannelHideNeedlesFromDatabase } from "./assignmentMatch";

/** Load `admin_hidden_filters` (needle = substring); channels whose name contains a needle are hidden from lists. */
export async function fetchAndApplyChannelHideNeedles(): Promise<void> {
  const url = import.meta.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    setChannelHideNeedlesFromDatabase(null);
    return;
  }
  const sb = createClient(url, key);
  const { data, error } = await sb
    .from("admin_hidden_filters")
    .select("needle")
    .order("needle", { ascending: true });
  if (error) {
    console.warn("[admin_hidden_filters]", error.message);
    setChannelHideNeedlesFromDatabase(null);
    return;
  }
  const list = ((data ?? []) as { needle: string }[])
    .map((r) => r.needle)
    .filter((n) => typeof n === "string" && n.trim());
  setChannelHideNeedlesFromDatabase(list.length ? list : null);
}
