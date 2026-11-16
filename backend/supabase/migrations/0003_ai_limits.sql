-- 0003: daily AI limits per person and per house, in calls and in tokens, and a trial allowance for houses
-- Jewel Labs has not approved yet.
--
-- Before this, the only limit was a call count per house, so one free account (up to 5 houses) got 3,000 calls a
-- day, and a call count does not limit very large requests. Now:
--   * workspaces.ai_approved: set by Jewel Labs only. Houses the desk creates start approved; houses made by
--     self sign-up start in trial (a small allowance). Houses that exist when this runs keep their allowance.
--   * ai_user_usage: calls and tokens per person per day, across all their houses (desk staff are not limited).
--   * reserve_ai_call(p_workspace, p_user, ...limits) checks all of these and answers 'ok' or which limit was hit.
--   * bump_ai_usage(p_workspace, p_user, ...) adds the tokens to the house and to the person.
--
-- Apply this before deploying the ai Edge Function that calls the new functions. The older
-- reserve_ai_call(uuid, integer) and bump_ai_usage(uuid, bigint, bigint) stay, so the function deployed now keeps
-- working until then; a later migration can drop them. Safe to run more than once.

-- =====================================================================================================
-- Which houses Jewel Labs approved for the full allowance
-- =====================================================================================================

-- The column starts true for the houses that already exist (they keep the allowance they had), then the default
-- becomes false for new houses. Running this again changes nothing.
alter table public.workspaces add column if not exists ai_approved boolean not null default true;
alter table public.workspaces alter column ai_approved set default false;

-- Authenticated users may update only (name, environment, data) of workspaces (0001), so they cannot set
-- ai_approved. This trigger refuses it anyway, whatever the grants say later.
create or replace function public.guard_workspace()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.environment is distinct from old.environment
     and auth.uid() is not null
     and not (is_desk() or is_owner(old.id)) then
    raise exception 'Only the house owner or Jewel Labs can switch between sandbox and live.';
  end if;
  if new.ai_approved is distinct from old.ai_approved and auth.uid() is not null and not is_desk() then
    raise exception 'Only Jewel Labs can approve a house for the AI.';
  end if;
  new.id := old.id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.rev := old.rev + 1;
  new.updated_at := now();
  return new;
end;
$$;

-- As in 0001, plus: a house Jewel Labs creates is approved for the AI from the start.
create or replace function public.create_house_for(p_user uuid, p_payload jsonb)
returns public.workspaces
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := left(btrim(coalesce(p_payload ->> 'name', '')), 120);
  v_environment text := 'sandbox';
  v_profile profiles;
  v_house workspaces;
begin
  if p_user is null then
    raise exception 'Sign in first.';
  end if;
  if v_name = '' then
    raise exception 'A house name is required.';
  end if;
  -- New houses start in sandbox. Only Jewel Labs can create a live one directly.
  if is_desk() and p_payload ->> 'environment' = 'live' then
    v_environment := 'live';
  end if;
  if not is_desk() and (select count(*) from workspaces w where w.created_by = p_user) >= 5 then
    raise exception 'You can create up to 5 houses. Ask Jewel Labs if you need more.';
  end if;

  insert into workspaces (name, environment, data, created_by, ai_approved)
  values (
    v_name,
    v_environment,
    coalesce(p_payload, '{}'::jsonb) - 'id' - 'name' - 'environment' - 'createdAt' - 'createdBy' - 'myRole' - 'rev',
    p_user,
    is_desk()
  )
  returning * into v_house;

  select * into v_profile from profiles p where p.user_id = p_user;
  insert into members (workspace_id, user_id, email, name, role)
  values (v_house.id, p_user, v_profile.email, coalesce(v_profile.name, ''), 'owner');

  return v_house;
end;
$$;

-- Jewel Labs approves a house for the full AI allowance (or takes it back). Desk users, or the SQL editor.
create or replace function public.approve_house_ai(p_workspace uuid, p_approved boolean default true)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and not is_desk() then
    raise exception 'Only Jewel Labs can approve a house for the AI.';
  end if;
  update workspaces w set ai_approved = coalesce(p_approved, false) where w.id = p_workspace;
  return found;
end;
$$;

-- =====================================================================================================
-- Usage per person per day (UTC), next to ai_usage (per house per day)
-- =====================================================================================================

create table if not exists public.ai_user_usage (
  user_id       uuid not null references auth.users (id) on delete cascade,
  day           date not null,
  calls         integer not null default 0,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  primary key (user_id, day)
);
alter table public.ai_user_usage enable row level security; -- no policies: only the functions below use it
revoke all on table public.ai_user_usage from anon, authenticated;
grant all on table public.ai_user_usage to service_role;

-- Internal (ai Edge Function): counts one AI call for today, unless a limit is reached. Answers 'ok', or which limit
-- was reached: 'trial_calls', 'trial_tokens' (a house Jewel Labs has not approved yet), 'house_calls',
-- 'house_tokens', 'user_calls', 'user_tokens' (one person across all their houses; desk staff are not limited),
-- 'no_house' or 'no_user'. A missing limit counts as 0, so nothing slips through.
create or replace function public.reserve_ai_call(
  p_workspace uuid,
  p_user uuid,
  p_house_calls integer,
  p_trial_calls integer,
  p_user_calls integer,
  p_house_tokens bigint,
  p_trial_tokens bigint,
  p_user_tokens bigint
)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_approved boolean;
  v_desk boolean;
  v_house ai_usage;
  v_person ai_user_usage;
begin
  select w.ai_approved into v_approved from workspaces w where w.id = p_workspace;
  if v_approved is null then
    return 'no_house';
  end if;
  if p_user is null then
    return 'no_user';
  end if;
  v_desk := coalesce((select p.is_desk from profiles p where p.user_id = p_user), false);

  -- Today's rows, locked (house first, then person): calls made at the same moment are counted one by one.
  insert into ai_usage (workspace_id, day) values (p_workspace, v_day) on conflict do nothing;
  select * into v_house from ai_usage u where u.workspace_id = p_workspace and u.day = v_day for update;
  insert into ai_user_usage (user_id, day) values (p_user, v_day) on conflict do nothing;
  select * into v_person from ai_user_usage u where u.user_id = p_user and u.day = v_day for update;

  if v_approved then
    if v_house.calls >= coalesce(p_house_calls, 0) then return 'house_calls'; end if;
    if v_house.input_tokens + v_house.output_tokens >= coalesce(p_house_tokens, 0) then return 'house_tokens'; end if;
  else
    if v_house.calls >= coalesce(p_trial_calls, 0) then return 'trial_calls'; end if;
    if v_house.input_tokens + v_house.output_tokens >= coalesce(p_trial_tokens, 0) then return 'trial_tokens'; end if;
  end if;
  if not v_desk then
    if v_person.calls >= coalesce(p_user_calls, 0) then return 'user_calls'; end if;
    if v_person.input_tokens + v_person.output_tokens >= coalesce(p_user_tokens, 0) then return 'user_tokens'; end if;
  end if;

  update ai_usage u set calls = u.calls + 1 where u.workspace_id = p_workspace and u.day = v_day;
  update ai_user_usage u set calls = u.calls + 1 where u.user_id = p_user and u.day = v_day;
  return 'ok';
end;
$$;

-- Internal (ai Edge Function): adds the tokens of a finished AI call to the house and to the person.
create or replace function public.bump_ai_usage(p_workspace uuid, p_user uuid, p_input bigint, p_output bigint)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_input bigint := greatest(coalesce(p_input, 0), 0);
  v_output bigint := greatest(coalesce(p_output, 0), 0);
begin
  insert into ai_usage as u (workspace_id, day, input_tokens, output_tokens)
  values (p_workspace, v_day, v_input, v_output)
  on conflict (workspace_id, day) do update
    set input_tokens = u.input_tokens + excluded.input_tokens,
        output_tokens = u.output_tokens + excluded.output_tokens;
  if p_user is not null then
    insert into ai_user_usage as u (user_id, day, input_tokens, output_tokens)
    values (p_user, v_day, v_input, v_output)
    on conflict (user_id, day) do update
      set input_tokens = u.input_tokens + excluded.input_tokens,
          output_tokens = u.output_tokens + excluded.output_tokens;
  end if;
end;
$$;

-- =====================================================================================================
-- Grants (functions are callable by everyone unless revoked)
-- =====================================================================================================

revoke all on function
  public.guard_workspace(), public.create_house_for(uuid, jsonb), public.approve_house_ai(uuid, boolean),
  public.reserve_ai_call(uuid, uuid, integer, integer, integer, bigint, bigint, bigint),
  public.bump_ai_usage(uuid, uuid, bigint, bigint)
from public, anon, authenticated;

grant execute on function public.approve_house_ai(uuid, boolean) to authenticated, service_role;
grant execute on function
  public.create_house_for(uuid, jsonb),
  public.reserve_ai_call(uuid, uuid, integer, integer, integer, bigint, bigint, bigint),
  public.bump_ai_usage(uuid, uuid, bigint, bigint)
to service_role;
