-- Jewel Labs Desk: database for the cloud (Supabase).
--
-- One generic "records" table holds every collection of every house (documents, shipments, stones, ...), so the
-- app can add collections without a migration. Row-level security (RLS) decides who sees what:
--   * members read the records of their houses; owners, preparers and desk members also write them; viewers only read
--   * desk users (profiles.is_desk, Jewel Labs staff) read and write every house
--   * everything else goes through the functions below, which check the caller themselves
--
-- Safe to run more than once. Applied with `supabase db push` (see ../README.md).

create extension if not exists pgcrypto with schema extensions; -- gen_random_bytes for invite codes

-- =====================================================================================================
-- Tables
-- =====================================================================================================

create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text,
  name       text not null default '',
  is_desk    boolean not null default false, -- Jewel Labs staff: set by an admin with SQL, never by the user
  is_test    boolean not null default false, -- test accounts, left out of metrics
  created_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  environment text not null default 'sandbox' check (environment in ('sandbox', 'live')),
  data        jsonb not null default '{}'::jsonb, -- the rest of the house settings (letterhead, permissions, ...)
  rev         integer not null default 1,         -- bumped on every change, so apps can skip old news
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists workspaces_created_by_idx on public.workspaces (created_by);

create table if not exists public.members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  email        text,
  name         text not null default '',
  role         text not null check (role in ('owner', 'preparer', 'viewer', 'desk')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists members_user_id_idx on public.members (user_id);

create table if not exists public.invites (
  code         text primary key check (code ~ '^[A-Z0-9]{8}$'),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  role         text not null check (role in ('owner', 'preparer', 'viewer', 'desk')),
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '14 days',
  max_uses     integer not null default 20 check (max_uses > 0),
  uses         integer not null default 0 check (uses >= 0)
);
create index if not exists invites_workspace_id_idx on public.invites (workspace_id);

-- Every record of every collection. The app keeps the whole record in data; rev and updated_at are set here.
create table if not exists public.records (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  collection   text not null check (collection ~ '^[a-z][a-z0-9_]{0,63}$' and collection <> 'workspace'),
  id           text not null check (char_length(id) between 1 and 200),
  data         jsonb not null default '{}'::jsonb,
  rev          integer not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users (id) on delete set null,
  primary key (workspace_id, collection, id)
);

create table if not exists public.ai_usage (
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  day           date not null,
  calls         integer not null default 0,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  primary key (workspace_id, day)
);

-- Only one computer per house runs the agents at a time: the one holding the lease.
create table if not exists public.worker_leases (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  holder       text not null,
  expires_at   timestamptz not null
);

-- Wrong invite codes per person (join_with_code slows down guessing).
create table if not exists public.join_attempts (
  id      bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  at      timestamptz not null default now()
);
create index if not exists join_attempts_user_at_idx on public.join_attempts (user_id, at);

-- Sign-ups per network (the signup Edge Function stores a SHA-256 of the IP address, never the address).
create table if not exists public.signup_attempts (
  id      bigint generated always as identity primary key,
  ip_hash text not null,
  at      timestamptz not null default now()
);
create index if not exists signup_attempts_ip_at_idx on public.signup_attempts (ip_hash, at);

-- =====================================================================================================
-- Helper functions used by the policies. "security definer" lets them read members and profiles without
-- running into those tables' own policies. pg_temp is listed last so a temporary table cannot stand in for ours.
-- =====================================================================================================

create or replace function public.is_desk()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((select p.is_desk from profiles p where p.user_id = auth.uid()), false);
$$;

create or replace function public.is_member(ws uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from members m where m.workspace_id = ws and m.user_id = auth.uid());
$$;

create or replace function public.is_owner(ws uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from members m where m.workspace_id = ws and m.user_id = auth.uid() and m.role = 'owner');
$$;

-- Who may change a house's records and settings: its owners, preparers and desk members, and desk users.
create or replace function public.can_write(ws uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select is_desk() or exists (
    select 1 from members m
    where m.workspace_id = ws and m.user_id = auth.uid() and m.role in ('owner', 'preparer', 'desk')
  );
$$;

-- Storage objects are named <workspace_id>/<file key>. Returns that workspace id, or null.
create or replace function public.workspace_from_path(object_name text)
returns uuid
language sql immutable
set search_path = public, pg_temp
as $$
  select case
    when split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(object_name, '/', 1)::uuid
  end;
$$;

-- =====================================================================================================
-- Triggers
-- =====================================================================================================

-- A profile for every new account (the name comes from the sign-up form).
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  insert into profiles (user_id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'name', ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists jl_on_auth_user_created on auth.users;
create trigger jl_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Accounts that existed before this migration get a profile too.
insert into public.profiles (user_id, email, name)
select u.id, u.email, coalesce(u.raw_user_meta_data ->> 'name', '')
from auth.users u
on conflict (user_id) do nothing;

-- Every save of a record bumps rev and stamps who and when. The app cannot set these itself.
create or replace function public.stamp_record()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'UPDATE' then
    new.rev := old.rev + 1;
  else
    new.rev := 1;
  end if;
  return new;
end;
$$;

create or replace trigger jl_stamp_record
  before insert or update on public.records
  for each row execute function public.stamp_record();

-- Settings changes bump rev. Only the owner or Jewel Labs may switch a house between sandbox and live.
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
  new.id := old.id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.rev := old.rev + 1;
  new.updated_at := now();
  return new;
end;
$$;

create or replace trigger jl_guard_workspace
  before update on public.workspaces
  for each row execute function public.guard_workspace();

-- =====================================================================================================
-- Functions the app calls (RPCs). Parameters start with p_ so they never clash with column names.
-- =====================================================================================================

-- Internal: creates a house for a person and makes them its owner. Used by create_house and the signup function.
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

  insert into workspaces (name, environment, data, created_by)
  values (
    v_name,
    v_environment,
    coalesce(p_payload, '{}'::jsonb) - 'id' - 'name' - 'environment' - 'createdAt' - 'createdBy' - 'myRole' - 'rev',
    p_user
  )
  returning * into v_house;

  select * into v_profile from profiles p where p.user_id = p_user;
  insert into members (workspace_id, user_id, email, name, role)
  values (v_house.id, p_user, v_profile.email, coalesce(v_profile.name, ''), 'owner');

  return v_house;
end;
$$;

-- A new house (onboarding). The caller becomes its owner.
create or replace function public.create_house(p_payload jsonb)
returns public.workspaces
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  return create_house_for(auth.uid(), p_payload);
end;
$$;

-- Saves a settings change: only the top-level keys sent are replaced. Runs with the caller's rights, so the
-- workspaces policies decide who may do it.
create or replace function public.update_house(p_workspace uuid, p_patch jsonb)
returns public.workspaces
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_house workspaces;
begin
  update workspaces w
  set name = coalesce(nullif(left(btrim(p_patch ->> 'name'), 120), ''), w.name),
      environment = coalesce(p_patch ->> 'environment', w.environment),
      data = w.data || (coalesce(p_patch, '{}'::jsonb) - 'id' - 'name' - 'environment' - 'createdAt' - 'createdBy' - 'myRole' - 'rev')
  where w.id = p_workspace
  returning * into v_house;
  if not found then
    raise exception 'You cannot change the settings of this house.';
  end if;
  return v_house;
end;
$$;

-- A new invite code for a house: 8 characters without look-alikes (no I, L, O, 0 or 1), valid for 14 days.
create or replace function public.create_invite(p_workspace uuid, p_role text default 'preparer')
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if p_role is null or p_role not in ('owner', 'preparer', 'viewer', 'desk') then
    raise exception 'Unknown role. Use owner, preparer, viewer or desk.';
  end if;
  if not (is_owner(p_workspace) or is_desk()) then
    raise exception 'Only the house owner or Jewel Labs can create invite codes.';
  end if;
  if p_role = 'desk' and not is_desk() then
    raise exception 'Only Jewel Labs can invite desk members.';
  end if;

  for attempt in 1..10 loop
    v_bytes := extensions.gen_random_bytes(8);
    v_code := '';
    for i in 0..7 loop
      v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % length(v_alphabet)) + 1, 1);
    end loop;
    begin
      insert into invites (code, workspace_id, role, created_by)
      values (v_code, p_workspace, p_role, auth.uid());
      return v_code;
    exception when unique_violation then
      null; -- that code is taken (very rare): try another one
    end;
  end loop;
  raise exception 'Could not create an invite code. Try again.';
end;
$$;

-- Internal: uses an invite code for a person. Returns the house id, or null when the code is not valid.
-- Someone who is already a member keeps their role.
create or replace function public.redeem_invite(p_code text, p_user uuid)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_invite invites;
  v_profile profiles;
begin
  select * into v_invite
  from invites i
  where i.code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'))
  for update;
  if not found or v_invite.expires_at < now() or v_invite.uses >= v_invite.max_uses then
    return null;
  end if;

  select * into v_profile from profiles p where p.user_id = p_user;
  insert into members (workspace_id, user_id, email, name, role)
  values (v_invite.workspace_id, p_user, v_profile.email, coalesce(v_profile.name, ''), v_invite.role)
  on conflict (workspace_id, user_id) do nothing;
  if found then
    update invites i set uses = i.uses + 1 where i.code = v_invite.code;
  end if;
  return v_invite.workspace_id;
end;
$$;

-- A signed-in person joins a house with an invite code. Returns the house (empty when the code is not valid).
-- More than 10 wrong codes in an hour locks the person out for the rest of that hour.
create or replace function public.join_with_code(p_code text)
returns public.workspaces
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_workspace uuid;
  v_house workspaces;
begin
  if v_user is null then
    raise exception 'Sign in first.';
  end if;
  if (select count(*) from join_attempts a where a.user_id = v_user and a.at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many wrong codes. Wait an hour and try again.';
  end if;
  v_workspace := redeem_invite(p_code, v_user);
  if v_workspace is null then
    insert into join_attempts (user_id) values (v_user);
    return null;
  end if;
  select * into v_house from workspaces w where w.id = v_workspace;
  return v_house;
end;
$$;

-- The houses this person can open, with their role. Desk users see every house.
create or replace function public.list_my_workspaces()
returns table (
  id uuid, name text, environment text, data jsonb, rev integer,
  created_by uuid, created_at timestamptz, updated_at timestamptz, my_role text
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select w.id, w.name, w.environment, w.data, w.rev, w.created_by, w.created_at, w.updated_at,
         coalesce(m.role, 'desk') as my_role
  from workspaces w
  left join members m on m.workspace_id = w.id and m.user_id = auth.uid()
  where m.user_id is not null or is_desk()
  order by w.created_at;
$$;

-- One page of a house's records, in key order. The app asks for the page after the last row it got
-- (keyset paging), so rows added or removed meanwhile never make it skip one. Runs with the caller's rights.
create or replace function public.list_records(
  p_workspace uuid,
  p_after_collection text default '',
  p_after_id text default '',
  p_limit integer default 1000
)
returns setof public.records
language sql stable security invoker
set search_path = public, pg_temp
as $$
  select r.*
  from records r
  where r.workspace_id = p_workspace
    and (r.collection, r.id) > (coalesce(p_after_collection, ''), coalesce(p_after_id, ''))
  order by r.collection, r.id
  limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
$$;

-- Takes the house's worker lease for ttl seconds, or renews it. False when another computer holds it.
create or replace function public.acquire_lease(p_workspace uuid, p_holder text, p_ttl_seconds integer default 300)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_ok boolean;
begin
  if p_holder is null or btrim(p_holder) = '' or not can_write(p_workspace) then
    return false;
  end if;
  insert into worker_leases as l (workspace_id, holder, expires_at)
  values (
    p_workspace,
    left(p_holder, 200),
    now() + make_interval(secs => greatest(10, least(coalesce(p_ttl_seconds, 300), 3600)))
  )
  on conflict (workspace_id) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where l.expires_at < now() or l.holder = excluded.holder
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.release_lease(p_workspace uuid, p_holder text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if can_write(p_workspace) then
    delete from worker_leases l where l.workspace_id = p_workspace and l.holder = p_holder;
  end if;
end;
$$;

-- Internal (ai Edge Function): counts one AI call for today, unless the house already reached its daily cap.
create or replace function public.reserve_ai_call(p_workspace uuid, p_cap integer)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_ok boolean;
begin
  if coalesce(p_cap, 0) <= 0 then
    return false;
  end if;
  insert into ai_usage as u (workspace_id, day, calls)
  values (p_workspace, (now() at time zone 'utc')::date, 1)
  on conflict (workspace_id, day) do update
    set calls = u.calls + 1
    where u.calls < p_cap
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

-- Internal (ai Edge Function): adds the tokens of a finished AI call. The call itself was counted by
-- reserve_ai_call before the request went to OpenAI.
create or replace function public.bump_ai_usage(p_workspace uuid, p_input bigint, p_output bigint)
returns void
language sql security definer
set search_path = public, pg_temp
as $$
  insert into ai_usage as u (workspace_id, day, input_tokens, output_tokens)
  values (p_workspace, (now() at time zone 'utc')::date, coalesce(p_input, 0), coalesce(p_output, 0))
  on conflict (workspace_id, day) do update
    set input_tokens = u.input_tokens + excluded.input_tokens,
        output_tokens = u.output_tokens + excluded.output_tokens;
$$;

-- Internal (signup Edge Function): notes a sign-up attempt. False once a network made p_limit tries in an hour.
create or replace function public.note_signup_attempt(p_ip_hash text, p_limit integer default 10)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_recent integer;
begin
  delete from signup_attempts s where s.at < now() - interval '1 day';
  select count(*) into v_recent
  from signup_attempts s
  where s.ip_hash = p_ip_hash and s.at > now() - interval '1 hour';
  insert into signup_attempts (ip_hash) values (coalesce(p_ip_hash, 'unknown'));
  return v_recent < coalesce(p_limit, 10);
end;
$$;

-- =====================================================================================================
-- Row-level security
-- =====================================================================================================

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
alter table public.records enable row level security;
alter table public.ai_usage enable row level security;
alter table public.worker_leases enable row level security;
alter table public.join_attempts enable row level security;   -- no policies: only the functions above use it
alter table public.signup_attempts enable row level security; -- no policies: only the functions above use it

-- (select ...) around is_desk() makes Postgres run it once per query instead of once per row.

drop policy if exists "profiles: read own, desk reads all" on public.profiles;
create policy "profiles: read own, desk reads all" on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_desk()));

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "workspaces: members and desk read" on public.workspaces;
create policy "workspaces: members and desk read" on public.workspaces
  for select to authenticated
  using (public.is_member(id) or (select public.is_desk()));

drop policy if exists "workspaces: writers update" on public.workspaces;
create policy "workspaces: writers update" on public.workspaces
  for update to authenticated
  using (public.can_write(id))
  with check (public.can_write(id));

drop policy if exists "members: house members and desk read" on public.members;
create policy "members: house members and desk read" on public.members
  for select to authenticated
  using (public.is_member(workspace_id) or (select public.is_desk()));

drop policy if exists "members: owner or desk removes, anyone leaves" on public.members;
create policy "members: owner or desk removes, anyone leaves" on public.members
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.is_owner(workspace_id) or (select public.is_desk()));

drop policy if exists "invites: owner and desk read" on public.invites;
create policy "invites: owner and desk read" on public.invites
  for select to authenticated
  using (public.is_owner(workspace_id) or (select public.is_desk()));

drop policy if exists "records: members and desk read" on public.records;
create policy "records: members and desk read" on public.records
  for select to authenticated
  using (public.is_member(workspace_id) or (select public.is_desk()));

drop policy if exists "records: writers insert" on public.records;
create policy "records: writers insert" on public.records
  for insert to authenticated
  with check (public.can_write(workspace_id));

drop policy if exists "records: writers update" on public.records;
create policy "records: writers update" on public.records
  for update to authenticated
  using (public.can_write(workspace_id))
  with check (public.can_write(workspace_id));

drop policy if exists "records: writers delete" on public.records;
create policy "records: writers delete" on public.records
  for delete to authenticated
  using (public.can_write(workspace_id));

drop policy if exists "ai usage: members and desk read" on public.ai_usage;
create policy "ai usage: members and desk read" on public.ai_usage
  for select to authenticated
  using (public.is_member(workspace_id) or (select public.is_desk()));

drop policy if exists "leases: members and desk read" on public.worker_leases;
create policy "leases: members and desk read" on public.worker_leases
  for select to authenticated
  using (public.is_member(workspace_id) or (select public.is_desk()));

-- =====================================================================================================
-- Grants. Start from nothing, then allow only what the app uses. (Newer Supabase projects no longer grant
-- these automatically, older ones grant too much; this works for both.)
-- =====================================================================================================

revoke all on table
  public.profiles, public.workspaces, public.members, public.invites, public.records,
  public.ai_usage, public.worker_leases, public.join_attempts, public.signup_attempts
from anon, authenticated;

grant all on table
  public.profiles, public.workspaces, public.members, public.invites, public.records,
  public.ai_usage, public.worker_leases, public.join_attempts, public.signup_attempts
to service_role;

grant select on public.profiles to authenticated;
grant update (name) on public.profiles to authenticated; -- never is_desk or is_test
grant select on public.workspaces to authenticated;
grant update (name, environment, data) on public.workspaces to authenticated;
grant select, delete on public.members to authenticated;
grant select on public.invites to authenticated;
grant select, insert, update, delete on public.records to authenticated;
grant select on public.ai_usage to authenticated;
grant select on public.worker_leases to authenticated;

-- Functions are callable by everyone (PUBLIC) unless revoked, so revoke first and grant on purpose.
revoke all on function
  public.is_desk(), public.is_member(uuid), public.is_owner(uuid), public.can_write(uuid),
  public.workspace_from_path(text), public.handle_new_user(), public.stamp_record(), public.guard_workspace(),
  public.create_house_for(uuid, jsonb), public.create_house(jsonb), public.update_house(uuid, jsonb),
  public.create_invite(uuid, text), public.redeem_invite(text, uuid), public.join_with_code(text),
  public.list_my_workspaces(), public.list_records(uuid, text, text, integer),
  public.acquire_lease(uuid, text, integer), public.release_lease(uuid, text),
  public.reserve_ai_call(uuid, integer), public.bump_ai_usage(uuid, bigint, bigint),
  public.note_signup_attempt(text, integer)
from public, anon, authenticated;

-- Used inside policies, and called by the app.
grant execute on function
  public.is_desk(), public.is_member(uuid), public.is_owner(uuid), public.can_write(uuid),
  public.workspace_from_path(text),
  public.create_house(jsonb), public.update_house(uuid, jsonb), public.create_invite(uuid, text),
  public.join_with_code(text), public.list_my_workspaces(), public.list_records(uuid, text, text, integer),
  public.acquire_lease(uuid, text, integer), public.release_lease(uuid, text)
to authenticated, service_role;

-- Only the Edge Functions (service role) call these.
grant execute on function
  public.create_house_for(uuid, jsonb), public.redeem_invite(text, uuid),
  public.reserve_ai_call(uuid, integer), public.bump_ai_usage(uuid, bigint, bigint),
  public.note_signup_attempt(text, integer)
to service_role;

-- =====================================================================================================
-- Realtime: apps listen to changes of records and house settings.
-- =====================================================================================================

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'records'
  ) then
    alter publication supabase_realtime add table public.records;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'workspaces'
  ) then
    alter publication supabase_realtime add table public.workspaces;
  end if;
end;
$$;

-- =====================================================================================================
-- Storage: one private bucket. Files are named <workspace_id>/<file key>; members of that house may read
-- them, writers may add, replace and delete them.
-- =====================================================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 52428800) -- 50 MB per file
on conflict (id) do update set public = false;

drop policy if exists "jl documents: members and desk read" on storage.objects;
create policy "jl documents: members and desk read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (public.is_member(public.workspace_from_path(name)) or (select public.is_desk()))
  );

drop policy if exists "jl documents: writers add" on storage.objects;
create policy "jl documents: writers add" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and public.can_write(public.workspace_from_path(name)));

drop policy if exists "jl documents: writers replace" on storage.objects;
create policy "jl documents: writers replace" on storage.objects
  for update to authenticated
  using (bucket_id = 'documents' and public.can_write(public.workspace_from_path(name)))
  with check (bucket_id = 'documents' and public.can_write(public.workspace_from_path(name)));

drop policy if exists "jl documents: writers delete" on storage.objects;
create policy "jl documents: writers delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and public.can_write(public.workspace_from_path(name)));
