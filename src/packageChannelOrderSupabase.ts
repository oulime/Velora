import type { SupabaseClient } from "@supabase/supabase-js";

export type PackageChannelOrderRow = {
  country_id: string;
  package_id: string;
  stream_order: number[] | string;
};

/** Key: `${country_id}::${package_id}` → ordered stream_ids */
export async function fetchDbPackageChannelOrders(sb: SupabaseClient): Promise<Map<string, number[]>> {
  const { data, error } = await sb
    .from("admin_package_channel_order")
    .select("country_id, package_id, stream_order");
  if (error) throw error;
  const m = new Map<string, number[]>();
  for (const raw of data ?? []) {
    const r = raw as PackageChannelOrderRow;
    const arr = Array.isArray(r.stream_order) ? r.stream_order : [];
    const ids = arr.map((x) => Number(x)).filter(Number.isFinite);
    m.set(`${r.country_id}::${r.package_id}`, ids);
  }
  return m;
}

export async function upsertPackageChannelOrder(
  sb: SupabaseClient,
  row: { country_id: string; package_id: string; stream_order: number[] }
): Promise<{ error?: string }> {
  const { error } = await sb.from("admin_package_channel_order").upsert(
    {
      country_id: row.country_id,
      package_id: row.package_id,
      stream_order: row.stream_order,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "country_id,package_id" }
  );
  if (error) return { error: error.message };
  return {};
}
