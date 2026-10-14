-- Run once in Supabase > SQL Editor. Lets twind limit nudges to one every 2 hours.
alter table public.days add column if not exists last_nudge_at timestamptz;
