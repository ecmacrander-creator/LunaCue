-- twind patch: no more stuck spins.
--   - If whoever spun doesn't lock it in within 30 minutes, the other person can.
--   - A past day that was spun but never locked can still be answered late.
-- Run once in Supabase > SQL Editor. Safe to run again.

-- When the current question was last spun (re-spins reset the 30-minute clock).
alter table public.days add column if not exists spun_at timestamptz;
update public.days set spun_at = created_at where spun_at is null;
alter table public.days alter column spun_at set default now();

create or replace function public.spin_today(p_wedge text, p_question text) returns public.days
language plpgsql security definer set search_path = public as $$
declare cid uuid := my_couple(); d date; r days;
begin
  if cid is null then raise exception 'not paired'; end if;
  d := couple_today(cid);
  insert into days (couple_id, day, spinner, wedge, question, spun_at)
    values (cid, d, auth.uid(), p_wedge, p_question, now())
    on conflict (couple_id, day) do nothing
    returning * into r;
  if r.couple_id is not null then return r; end if;

  select * into r from days where couple_id = cid and day = d for update;
  if r.locked then raise exception 'Today''s question is already locked in.'; end if;
  if r.spinner <> auth.uid() then raise exception 'Your partner already spun today.'; end if;
  if r.spins >= 2 then raise exception 'No re-spins left today.'; end if;
  update days set wedge = p_wedge, question = p_question, spins = spins + 1, spun_at = now()
    where couple_id = cid and day = d returning * into r;
  return r;
end $$;

-- The spinner can lock it in any time. The other person can after 30 minutes.
create or replace function public.lock_today() returns public.days
language plpgsql security definer set search_path = public as $$
declare cid uuid := my_couple(); r days;
begin
  update days set locked = true, locked_at = now()
    where couple_id = cid and day = couple_today(cid) and not locked
      and (spinner = auth.uid() or coalesce(spun_at, created_at) < now() - interval '30 minutes')
    returning * into r;
  if r.couple_id is null then raise exception 'Nothing to lock yet.'; end if;
  return r;
end $$;

-- Answer a past day you missed. If that day was spun but never locked, answering locks it.
create or replace function public.submit_late_answer(p_day date, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare cid uuid := my_couple();
begin
  if cid is null then raise exception 'not paired'; end if;
  if p_day >= couple_today(cid) then raise exception 'Use today''s screen for today''s question.'; end if;
  if not exists (select 1 from days where couple_id = cid and day = p_day) then
    raise exception 'There was no question that day.';
  end if;
  if exists (select 1 from answers where couple_id = cid and day = p_day and user_id = auth.uid()) then
    raise exception 'You already answered that day.';
  end if;
  insert into answers (couple_id, day, user_id, body) values (cid, p_day, auth.uid(), trim(p_body));
  update days set answered = array(select distinct unnest(answered || auth.uid())),
      locked = true, locked_at = coalesce(locked_at, now())
    where couple_id = cid and day = p_day;
end $$;

revoke all on function public.spin_today(text, text), public.lock_today(), public.submit_late_answer(date, text) from public, anon;
grant execute on function public.spin_today(text, text), public.lock_today(), public.submit_late_answer(date, text) to authenticated;

-- Tell the API about the changes right away.
notify pgrst, 'reload schema';
