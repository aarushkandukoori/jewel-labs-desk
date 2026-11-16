-- 0006: a ceiling on sign-ups from all networks together, besides the limit per network (0001).
--
-- The limit per network counts a hash of the caller's address. If an address can be faked, that limit alone does
-- not stop a flood of accounts; a ceiling for everyone together does. note_signup_attempt(p_ip_hash, p_limit,
-- p_global_limit) answers true and counts the try when this network made fewer than p_limit counted tries in the
-- last hour and all networks together fewer than p_global_limit. A refused try is not counted, so one network that
-- keeps trying cannot use up everyone's allowance. Tries are counted one at a time (a lock).
--
-- Apply this before deploying the signup Edge Function that calls it. The older note_signup_attempt(text, integer)
-- stays for the function deployed now; a later migration can drop it. Safe to run more than once.

create or replace function public.note_signup_attempt(p_ip_hash text, p_limit integer, p_global_limit integer)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := coalesce(p_ip_hash, 'unknown');
  v_mine integer;
  v_all integer;
begin
  perform pg_advisory_xact_lock(hashtext('jl_signup_attempts'));
  delete from signup_attempts s where s.at < now() - interval '1 day';
  select count(*) filter (where s.ip_hash = v_hash), count(*)
  into v_mine, v_all
  from signup_attempts s
  where s.at > now() - interval '1 hour';
  if v_mine >= coalesce(p_limit, 0) or v_all >= coalesce(p_global_limit, 0) then
    return false;
  end if;
  insert into signup_attempts (ip_hash) values (v_hash);
  return true;
end;
$$;

revoke all on function public.note_signup_attempt(text, integer, integer) from public, anon, authenticated;
grant execute on function public.note_signup_attempt(text, integer, integer) to service_role;
