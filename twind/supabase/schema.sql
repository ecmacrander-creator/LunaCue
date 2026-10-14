-- twind database setup
-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Safe to run once on a fresh project.

-- ---------- Tables ----------

create table public.couples (
  id uuid primary key default gen_random_uuid(),
  invite_code text unique not null default upper(substr(md5(random()::text), 1, 6)),
  tz text not null default 'America/Chicago',
  nudge_time text not null default '19:30',          -- local time, HH:MM on :00 or :30
  wedge_weights jsonb not null default
    '{"faith":"more","us":"normal","future":"normal","reflection":"normal","fun":"normal","intimacy":"less","revisit":"normal"}',
  created_at timestamptz not null default now()
);

create table public.members (
  user_id uuid primary key references auth.users on delete cascade,
  couple_id uuid not null references public.couples on delete cascade,
  display_name text not null,
  intimacy_opt_in boolean not null default false,
  joined_at timestamptz not null default now()
);

create table public.days (
  couple_id uuid not null references public.couples on delete cascade,
  day date not null,
  spinner uuid references auth.users,
  wedge text not null,
  question text not null,
  spins int not null default 1,
  locked boolean not null default false,
  locked_at timestamptz,
  answered uuid[] not null default '{}',               -- who has answered (not what they said)
  talk_prompt text,
  talked_at timestamptz,
  last_nudge_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (couple_id, day)
);

create table public.answers (
  couple_id uuid not null,
  day date not null,
  user_id uuid not null references auth.users on delete cascade,
  body text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (couple_id, day, user_id),
  foreign key (couple_id, day) references public.days on delete cascade
);

create table public.push_subs (
  endpoint text primary key,
  user_id uuid not null references auth.users on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- ---------- Helpers ----------

create or replace function public.my_couple() returns uuid
language sql stable security definer set search_path = public as $$
  select couple_id from members where user_id = auth.uid()
$$;

create or replace function public.couple_today(cid uuid) returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone tz)::date from couples where id = cid
$$;

create or replace function public.both_answered(cid uuid, d date) returns boolean
language sql stable security definer set search_path = public as $$
  select count(*) >= 2 from answers where couple_id = cid and day = d
$$;

-- ---------- Row level security ----------

alter table public.couples enable row level security;
alter table public.members enable row level security;
alter table public.days enable row level security;
alter table public.answers enable row level security;
alter table public.push_subs enable row level security;

create policy "couple read" on public.couples for select using (id = public.my_couple());
create policy "couple update" on public.couples for update using (id = public.my_couple()) with check (id = public.my_couple());

create policy "members read" on public.members for select using (couple_id = public.my_couple());
create policy "members update self" on public.members for update using (user_id = auth.uid()) with check (user_id = auth.uid() and couple_id = public.my_couple());

create policy "days read" on public.days for select using (couple_id = public.my_couple());

-- You always see your own answer. You see your partner's only once you have both answered.
create policy "answers read" on public.answers for select using (
  couple_id = public.my_couple()
  and (user_id = auth.uid() or public.both_answered(couple_id, day))
);

create policy "push subs own" on public.push_subs for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Couples' invite codes and settings can only change through the app's own fields.
revoke update on public.couples from anon, authenticated;
grant update (tz, nudge_time, wedge_weights) on public.couples to authenticated;
revoke update on public.members from anon, authenticated;
grant update (display_name, intimacy_opt_in) on public.members to authenticated;

-- ---------- Actions the app calls ----------

create or replace function public.create_couple(p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare c couples;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then raise exception 'already paired'; end if;
  insert into couples default values returning * into c;
  insert into members (user_id, couple_id, display_name) values (auth.uid(), c.id, trim(p_name));
  return c.invite_code;
end $$;

create or replace function public.join_couple(p_code text, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then raise exception 'already paired'; end if;
  select id into cid from couples where invite_code = upper(trim(p_code));
  if cid is null then raise exception 'That code did not match.'; end if;
  if (select count(*) from members where couple_id = cid) >= 2 then raise exception 'That twind already has two people.'; end if;
  insert into members (user_id, couple_id, display_name) values (auth.uid(), cid, trim(p_name));
end $$;

-- First spin of the day creates it. The spinner gets one re-spin until they lock it.
create or replace function public.spin_today(p_wedge text, p_question text) returns public.days
language plpgsql security definer set search_path = public as $$
declare cid uuid := my_couple(); d date; r days;
begin
  if cid is null then raise exception 'not paired'; end if;
  d := couple_today(cid);
  insert into days (couple_id, day, spinner, wedge, question)
    values (cid, d, auth.uid(), p_wedge, p_question)
    on conflict (couple_id, day) do nothing
    returning * into r;
  if r.couple_id is not null then return r; end if;

  select * into r from days where couple_id = cid and day = d for update;
  if r.locked then raise exception 'Today''s question is already locked in.'; end if;
  if r.spinner <> auth.uid() then raise exception 'Your partner already spun today.'; end if;
  if r.spins >= 2 then raise exception 'No re-spins left today.'; end if;
  update days set wedge = p_wedge, question = p_question, spins = spins + 1
    where couple_id = cid and day = d returning * into r;
  return r;
end $$;

create or replace function public.lock_today() returns public.days
language plpgsql security definer set search_path = public as $$
declare cid uuid := my_couple(); r days;
begin
  update days set locked = true, locked_at = now()
    where couple_id = cid and day = couple_today(cid) and spinner = auth.uid() and not locked
    returning * into r;
  if r.couple_id is null then raise exception 'Nothing to lock.'; end if;
  return r;
end $$;

-- You can edit your answer until your partner has answered too.
create or replace function public.submit_answer(p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare cid uuid := my_couple(); d date;
begin
  if cid is null then raise exception 'not paired'; end if;
  d := couple_today(cid);
  if not exists (select 1 from days where couple_id = cid and day = d and locked) then
    raise exception 'Today''s question is not locked yet.';
  end if;
  if both_answered(cid, d) then raise exception 'Answers are already revealed.'; end if;
  insert into answers (couple_id, day, user_id, body) values (cid, d, auth.uid(), trim(p_body))
    on conflict (couple_id, day, user_id) do update set body = excluded.body, updated_at = now();
  update days set answered = array(select distinct unnest(answered || auth.uid()))
    where couple_id = cid and day = d;
end $$;

create or replace function public.mark_talked(p_day date) returns void
language plpgsql security definer set search_path = public as $$
declare cid uuid := my_couple();
begin
  if not both_answered(cid, p_day) then raise exception 'You both need to answer first.'; end if;
  update days set talked_at = coalesce(talked_at, now()) where couple_id = cid and day = p_day;
end $$;

revoke all on function public.create_couple(text), public.join_couple(text, text), public.spin_today(text, text),
  public.lock_today(), public.submit_answer(text), public.mark_talked(date) from public, anon;
grant execute on function public.create_couple(text), public.join_couple(text, text), public.spin_today(text, text),
  public.lock_today(), public.submit_answer(text), public.mark_talked(date) to authenticated;

-- Lets someone who started their own twind by mistake (and is still alone in it)
-- walk away and enter their spouse's code instead.
create or replace function public.leave_couple() returns void
language plpgsql security definer set search_path = public as $$
declare cid uuid := my_couple();
begin
  if cid is null then return; end if;
  if (select count(*) from members where couple_id = cid) > 1 then
    raise exception 'You are already paired. A twind with two people can''t be left from the app.';
  end if;
  delete from couples where id = cid;
end $$;

revoke all on function public.leave_couple() from public, anon;
grant execute on function public.leave_couple() to authenticated;

-- ---------- Live updates between your two phones ----------

alter publication supabase_realtime add table public.days, public.answers, public.members;
