-- Trial IP whitelist (run in Supabase SQL editor).
-- Server APIs use SUPABASE_SERVICE_ROLE_KEY only; anon/authenticated have no table access.

create table if not exists public.trial_ip_whitelist (
    ip_address text primary key,
    label text null,
    notes text null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.trial_ip_whitelist enable row level security;

revoke all on table public.trial_ip_whitelist from anon;
revoke all on table public.trial_ip_whitelist from authenticated;

create or replace function public.is_trial_ip_whitelisted(client_ip text)
returns boolean as $$
begin
    return exists (
        select 1
        from public.trial_ip_whitelist
        where ip_address = client_ip
    );
end;
$$ language plpgsql security definer;

grant execute on function public.is_trial_ip_whitelisted(text) to service_role;
