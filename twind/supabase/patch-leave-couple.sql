-- Run once in Supabase > SQL Editor. Adds the 'use a different code' action.

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
