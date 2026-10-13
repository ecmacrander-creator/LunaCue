-- twind daily nudge: runs every 30 minutes and lets twind-notify decide
-- whether it's your nudge time. Replace the two placeholders, then run once
-- in Supabase > SQL Editor.
--   YOUR-PROJECT-REF  -> the part before .supabase.co in your project URL
--   YOUR-CRON-SECRET  -> the same value you saved as the CRON_SECRET secret

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'twind-daily-nudge',
  '0,30 * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/twind-notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'YOUR-CRON-SECRET'),
    body := '{"event":"daily"}'::jsonb
  );
  $$
);
