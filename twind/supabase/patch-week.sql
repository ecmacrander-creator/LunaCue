-- twind patch: midnight unlock, late answers, reactions, "save for later" and the weekly review.
-- Run once in Supabase > SQL Editor. Safe to run again.

-- ---------- Midnight unlock ----------
-- You always see your own answer. You see your partner's once you've both answered,
-- or once the day is over (midnight in your time zone), whichever comes first.
drop policy if exists "answers read" on public.answers;
create policy "answers read" on public.answers for select using (
  couple_id = public.my_couple()
  and (user_id = auth.uid() or public.both_answered(couple_id, day) or day < public.couple_today(couple_id))
);

-- True when I can see my partner's answer for that day.
create or replace function public.partner_visible(cid uuid, d date) returns boolean
language sql stable security definer set search_path = public as $$
  select both_answered(cid, d) or d < couple_today(cid)
$$;

-- ---------- Late answers ----------
-- Answer a past day you missed. One shot: once it's in, it's in.
create or replace function public.submit_late_answer(p_day date, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare cid uuid := my_couple();
begin
  if cid is null then raise exception 'not paired'; end if;
  if p_day >= couple_today(cid) then raise exception 'Use today''s screen for today''s question.'; end if;
  if not exists (select 1 from days where couple_id = cid and day = p_day and locked) then
    raise exception 'That day''s question was never locked in.';
  end if;
  if exists (select 1 from answers where couple_id = cid and day = p_day and user_id = auth.uid()) then
    raise exception 'You already answered that day.';
  end if;
  insert into answers (couple_id, day, user_id, body) values (cid, p_day, auth.uid(), trim(p_body));
  update days set answered = array(select distinct unnest(answered || auth.uid()))
    where couple_id = cid and day = p_day;
end $$;

-- ---------- Reactions and replies ----------
-- One row per person per day: how you responded to your partner's answer.
create table if not exists public.reactions (
  couple_id uuid not null,
  day date not null,
  from_user uuid not null references auth.users on delete cascade,
  heart boolean not null default false,
  more boolean not null default false,              -- "tell me more"
  reply text check (reply is null or char_length(reply) between 1 and 280),
  updated_at timestamptz not null default now(),
  primary key (couple_id, day, from_user),
  foreign key (couple_id, day) references public.days on delete cascade
);
alter table public.reactions enable row level security;
drop policy if exists "reactions read" on public.reactions;
create policy "reactions read" on public.reactions for select using (couple_id = public.my_couple());

create or replace function public.react(p_day date, p_heart boolean, p_more boolean, p_reply text) returns public.reactions
language plpgsql security definer set search_path = public as $$
declare cid uuid := my_couple(); r reactions; clean text := nullif(trim(coalesce(p_reply, '')), '');
begin
  if cid is null then raise exception 'not paired'; end if;
  if not exists (select 1 from answers where couple_id = cid and day = p_day and user_id <> auth.uid()) then
    raise exception 'There''s no answer to react to yet.';
  end if;
  if not partner_visible(cid, p_day) then raise exception 'Answer first to see their answer.'; end if;
  insert into reactions (couple_id, day, from_user, heart, more, reply)
    values (cid, p_day, auth.uid(), p_heart, p_more, clean)
    on conflict (couple_id, day, from_user) do update
      set heart = excluded.heart, more = excluded.more, reply = excluded.reply, updated_at = now()
    returning * into r;
  return r;
end $$;

-- ---------- Save for later ----------
alter table public.days add column if not exists saved_by uuid[] not null default '{}';

create or replace function public.toggle_save(p_day date) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare cid uuid := my_couple(); out uuid[];
begin
  if cid is null then raise exception 'not paired'; end if;
  update days set saved_by = case
      when auth.uid() = any(saved_by) then array_remove(saved_by, auth.uid())
      else saved_by || auth.uid() end
    where couple_id = cid and day = p_day
    returning saved_by into out;
  if out is null then raise exception 'No question that day.'; end if;
  return out;
end $$;

-- ---------- Weekly review ----------
-- Weeks run Monday to Sunday. The Gemini recap is written by twind-ai and cached here.
create table if not exists public.weeks (
  couple_id uuid not null references public.couples on delete cascade,
  week_start date not null,
  summary text,
  talk_prompt text,
  revealed_count int not null default 0,            -- how many shared days the recap was written from
  created_at timestamptz not null default now(),
  primary key (couple_id, week_start)
);
alter table public.weeks enable row level security;
drop policy if exists "weeks read" on public.weeks;
create policy "weeks read" on public.weeks for select using (couple_id = public.my_couple());

-- ---------- Permissions ----------
revoke all on function public.submit_late_answer(date, text), public.react(date, boolean, boolean, text),
  public.toggle_save(date), public.partner_visible(uuid, date) from public, anon;
grant execute on function public.submit_late_answer(date, text), public.react(date, boolean, boolean, text),
  public.toggle_save(date), public.partner_visible(uuid, date) to authenticated;

-- ---------- Live updates ----------
do $$ begin
  alter publication supabase_realtime add table public.reactions;
exception when duplicate_object then null; end $$;
