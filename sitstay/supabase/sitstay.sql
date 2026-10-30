-- SitStay reminders and backup. Run in Supabase > SQL Editor (same project as twind).
-- Safe to run again: it updates what is already there.
-- Replace YOUR-CRON-SECRET with the CRON_SECRET value you already saved for twind.

create table if not exists public.sitstay_pings (
  endpoint text not null,
  kind text not null,
  p256dh text not null,
  auth text not null,
  due_at timestamptz not null,
  body text not null default '',
  sent boolean not null default false,
  primary key (endpoint, kind)
);
-- No policies: only the sitstay-notify function (service role) can read it.
alter table public.sitstay_pings enable row level security;

-- The app calls this to set or clear one reminder for this phone.
create or replace function public.sitstay_schedule(
  p_endpoint text, p_p256dh text, p_auth text, p_kind text, p_due timestamptz, p_body text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_kind not in ('lunch', 'weak', 'last', 'away', 'free') or p_endpoint not like 'https://%' or length(p_endpoint) > 1000 then
    raise exception 'bad request';
  end if;
  if p_due is null then
    delete from sitstay_pings where endpoint = p_endpoint and kind = p_kind;
    return;
  end if;
  insert into sitstay_pings (endpoint, kind, p256dh, auth, due_at, body, sent)
  values (p_endpoint, p_kind, p_p256dh, p_auth, p_due, left(coalesce(p_body, ''), 200), false)
  on conflict (endpoint, kind) do update
    set p256dh = excluded.p256dh, auth = excluded.auth, due_at = excluded.due_at, body = excluded.body, sent = false;
end $$;
revoke all on function public.sitstay_schedule(text, text, text, text, timestamptz, text) from public;
grant execute on function public.sitstay_schedule(text, text, text, text, timestamptz, text) to anon, authenticated;

-- Backup: the whole SitStay save, keyed by a long random backup code that only the app knows.
create table if not exists public.sitstay_saves (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.sitstay_saves enable row level security;

create or replace function public.sitstay_backup(p_id text, p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if length(p_id) < 20 or length(p_id) > 100 or length(p_data::text) > 500000 then raise exception 'bad request'; end if;
  insert into sitstay_saves (id, data, updated_at) values (p_id, p_data, now())
  on conflict (id) do update set data = excluded.data, updated_at = now();
end $$;

create or replace function public.sitstay_restore(p_id text) returns jsonb
language sql stable security definer set search_path = public as $$
  select data from sitstay_saves where id = p_id and length(p_id) >= 20;
$$;

revoke all on function public.sitstay_backup(text, jsonb) from public;
revoke all on function public.sitstay_restore(text) from public;
grant execute on function public.sitstay_backup(text, jsonb) to anon, authenticated;
grant execute on function public.sitstay_restore(text) to anon, authenticated;

-- Check for due reminders every minute (the "come back" nudge is time sensitive).
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule(
  'sitstay-pings',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://sitbhlanzkvouezbegcm.supabase.co/functions/v1/sitstay-notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'YOUR-CRON-SECRET'),
    body := '{}'::jsonb
  );
  $$
);
