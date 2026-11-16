-- 0005: invite codes that can be withdrawn, and desk invites for one named person.
--
-- Before this, redeeming a desk invite (0002) made the person Jewel Labs desk staff (every house, every file), and a
-- desk invite worked like any other: 20 uses for 14 days, for any account, with no way to withdraw a code. Now:
--   * desk invites are made with create_desk_invite(house, email): one use, 4 hours, and only an account with that
--     email address (confirmed) can redeem it. create_invite no longer makes desk invites. Desk invites made before
--     this (no email) stop working. Owners no longer see desk invites of their house.
--   * revoke_invite(code): the house owner (or Jewel Labs) withdraws a code at once.
--   * removing someone from a house (not leaving on their own) expires the house's open codes, so a removed person
--     cannot come back with the code they first used. The owner makes new codes for anyone still to join.
--   * every change of profiles.is_desk is written to desk_grants (who, when, how): by invite or by SQL.
-- Safe to run more than once.

alter table public.invites add column if not exists email text; -- set for an invite that names one person (lower case)

-- =====================================================================================================
-- Audit of desk access
-- =====================================================================================================

create table if not exists public.desk_grants (
  id         bigint generated always as identity primary key,
  user_id    uuid not null, -- no foreign key: the record stays when the account is deleted
  is_desk    boolean not null, -- true: desk access given; false: taken away
  changed_by uuid, -- the signed-in person who did it; null for the SQL editor or an Edge Function
  via        text not null, -- 'desk invite <code>', or 'sql (<database user>)' for a direct change
  at         timestamptz not null default now()
);
create index if not exists desk_grants_user_idx on public.desk_grants (user_id, at);
alter table public.desk_grants enable row level security;
revoke all on table public.desk_grants from anon, authenticated;
grant select on table public.desk_grants to authenticated;
grant all on table public.desk_grants to service_role;

drop policy if exists "desk grants: desk reads" on public.desk_grants;
create policy "desk grants: desk reads" on public.desk_grants
  for select to authenticated
  using ((select public.is_desk()));

-- redeem_invite names the code in a setting of its own transaction (jl.desk_invite); anything else is a direct change.
create or replace function public.note_desk_change()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_desk is distinct from old.is_desk then
    insert into desk_grants (user_id, is_desk, changed_by, via)
    values (
      new.user_id, new.is_desk, auth.uid(),
      coalesce(nullif(current_setting('jl.desk_invite', true), ''), format('sql (%s)', session_user))
    );
  end if;
  return new;
end;
$$;

drop trigger if exists jl_note_desk_change on public.profiles;
create trigger jl_note_desk_change
  after update of is_desk on public.profiles
  for each row execute function public.note_desk_change();

-- =====================================================================================================
-- Making codes
-- =====================================================================================================

-- Internal: stores an invite under a new 8-character code (no look-alikes: no I, L, O, 0 or 1) and returns the code.
create or replace function public.insert_invite(
  p_workspace uuid, p_role text, p_email text, p_max_uses integer, p_expires_at timestamptz
)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_code text;
begin
  for attempt in 1..10 loop
    v_bytes := extensions.gen_random_bytes(8);
    v_code := '';
    for i in 0..7 loop
      v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % length(v_alphabet)) + 1, 1);
    end loop;
    begin
      insert into invites (code, workspace_id, role, created_by, email, max_uses, expires_at)
      values (v_code, p_workspace, p_role, auth.uid(), p_email, p_max_uses, p_expires_at);
      return v_code;
    exception when unique_violation then
      null; -- that code is taken (very rare): try another one
    end;
  end loop;
  raise exception 'Could not create an invite code. Try again.';
end;
$$;

-- A new invite code for a house, valid for 14 days and 20 people (as in 0001). Not for desk staff.
create or replace function public.create_invite(p_workspace uuid, p_role text default 'preparer')
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
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
  if p_role = 'desk' then
    raise exception 'A desk invite is for one person: use create_desk_invite(house id, their email).';
  end if;
  return insert_invite(p_workspace, p_role, null, 20, now() + interval '14 days');
end;
$$;

-- A desk invite for one person: one use, valid for 4 hours, only for an account with that email address.
-- Redeeming it makes the person Jewel Labs desk staff. Desk users, or the SQL editor.
create or replace function public.create_desk_invite(p_workspace uuid, p_email text)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if auth.uid() is not null and not is_desk() then
    raise exception 'Only Jewel Labs can invite desk members.';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Give the email address of the person to invite.';
  end if;
  if not exists (select 1 from workspaces w where w.id = p_workspace) then
    raise exception 'That house was not found.';
  end if;
  return insert_invite(p_workspace, 'desk', v_email, 1, now() + interval '4 hours');
end;
$$;

-- =====================================================================================================
-- Using and withdrawing codes
-- =====================================================================================================

-- Internal: uses an invite code for a person. Returns the house id, or null when the code is not valid for them.
-- Someone who is already a member keeps their role. A desk invite also turns on desk access for the person.
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
  -- expires_at is the first moment the code no longer works (revoke_invite sets it to now()).
  if not found or v_invite.expires_at <= now() or v_invite.uses >= v_invite.max_uses then
    return null;
  end if;
  if v_invite.role = 'desk' and v_invite.email is null then
    return null; -- a desk invite from before 0005, for anyone: no longer valid
  end if;
  -- An invite that names a person works only for an account with that email address, confirmed.
  if v_invite.email is not null and not exists (
    select 1 from auth.users u
    where u.id = p_user and lower(u.email) = v_invite.email and u.email_confirmed_at is not null
  ) then
    return null;
  end if;

  select * into v_profile from profiles p where p.user_id = p_user;
  insert into members (workspace_id, user_id, email, name, role)
  values (v_invite.workspace_id, p_user, v_profile.email, coalesce(v_profile.name, ''), v_invite.role)
  on conflict (workspace_id, user_id) do nothing;
  if found then
    update invites i set uses = i.uses + 1 where i.code = v_invite.code;
  end if;

  if v_invite.role = 'desk' then
    perform set_config('jl.desk_invite', 'desk invite ' || v_invite.code, true); -- for the desk_grants row
    update profiles p set is_desk = true where p.user_id = p_user;
    perform set_config('jl.desk_invite', '', true);
  end if;
  return v_invite.workspace_id;
end;
$$;

-- Withdraws an invite code at once. The house owner (not for desk invites) or Jewel Labs. Answers true when the
-- code was withdrawn; false when there is no such code or it is not the caller's to withdraw (the same answer,
-- so nobody can test which codes exist).
create or replace function public.revoke_invite(p_code text)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_invite invites;
begin
  select * into v_invite
  from invites i
  where i.code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'))
  for update;
  if not found then
    return false;
  end if;
  if auth.uid() is not null and not (is_desk() or (is_owner(v_invite.workspace_id) and v_invite.role <> 'desk')) then
    return false;
  end if;
  update invites i set expires_at = least(i.expires_at, now()) where i.code = v_invite.code;
  return true;
end;
$$;

-- When someone is removed from a house (by its owner or Jewel Labs, not leaving on their own), the house's open
-- codes expire, so the removed person cannot come back with the code they first used.
create or replace function public.expire_invites_after_removal()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if old.user_id is distinct from auth.uid() then
    update invites i set expires_at = now()
    where i.workspace_id = old.workspace_id and i.expires_at > now();
  end if;
  return old;
end;
$$;

drop trigger if exists jl_expire_invites_after_removal on public.members;
create trigger jl_expire_invites_after_removal
  after delete on public.members
  for each row execute function public.expire_invites_after_removal();

-- Owners see their house's codes, but not desk invites (those are for Jewel Labs staff only).
drop policy if exists "invites: owner and desk read" on public.invites;
create policy "invites: owner and desk read" on public.invites
  for select to authenticated
  using ((public.is_owner(workspace_id) and role <> 'desk') or (select public.is_desk()));

-- =====================================================================================================
-- Grants
-- =====================================================================================================

revoke all on function
  public.note_desk_change(), public.insert_invite(uuid, text, text, integer, timestamptz),
  public.create_invite(uuid, text), public.create_desk_invite(uuid, text), public.redeem_invite(text, uuid),
  public.revoke_invite(text), public.expire_invites_after_removal()
from public, anon, authenticated;

grant execute on function
  public.create_invite(uuid, text), public.create_desk_invite(uuid, text), public.revoke_invite(text)
to authenticated, service_role;
grant execute on function public.redeem_invite(text, uuid) to service_role;
