-- Bouquets (noms catalogue Nodecast) affichés pour tous les pays — partagé entre tous les clients.
-- Exécuter dans le SQL editor Supabase (migration additive).

create table if not exists public.admin_global_package_allowlist (
  id uuid primary key default gen_random_uuid(),
  bouquet_name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists admin_global_package_allowlist_sort_idx
  on public.admin_global_package_allowlist (sort_order, bouquet_name);

alter table public.admin_global_package_allowlist enable row level security;

drop policy if exists "open read/write admin_global_package_allowlist" on public.admin_global_package_allowlist;

create policy "open read/write admin_global_package_allowlist"
on public.admin_global_package_allowlist for all to anon, authenticated using (true) with check (true);
