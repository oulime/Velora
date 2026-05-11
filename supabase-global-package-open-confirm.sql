-- Texte du popup de confirmation avant d’ouvrir un bouquet « tous pays » (liste globale).
-- Exécuter dans le SQL editor Supabase (migration additive).

create table if not exists public.admin_global_package_open_confirm (
  id smallint primary key check (id = 1),
  message text not null default '',
  yes_label text not null default 'Oui',
  no_label text not null default 'Non',
  updated_at timestamptz not null default now()
);

insert into public.admin_global_package_open_confirm (id, message, yes_label, no_label)
values (1, '', 'Oui', 'Non')
on conflict (id) do nothing;

alter table public.admin_global_package_open_confirm enable row level security;

drop policy if exists "open read/write admin_global_package_open_confirm"
  on public.admin_global_package_open_confirm;

create policy "open read/write admin_global_package_open_confirm"
on public.admin_global_package_open_confirm for all to anon, authenticated using (true) with check (true);
