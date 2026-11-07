-- twind patch: answer blind, every day.
-- Your partner's answer stays hidden until you've answered too, even on past days you missed.
-- (Replaces the old midnight unlock.) Run once in Supabase > SQL Editor. Safe to run again.

drop policy if exists "answers read" on public.answers;
create policy "answers read" on public.answers for select using (
  couple_id = public.my_couple()
  and (user_id = auth.uid() or public.both_answered(couple_id, day))
);

-- Reacting to your partner's answer needs you to be able to see it, so this follows the same rule.
create or replace function public.partner_visible(cid uuid, d date) returns boolean
language sql stable security definer set search_path = public as $$
  select both_answered(cid, d)
$$;

notify pgrst, 'reload schema';
