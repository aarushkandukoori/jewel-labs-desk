-- 0002: redeeming an invite whose role is 'desk' makes the person Jewel Labs desk staff,
-- so they can open every house from the Desk view. Only desk users (or the project owner in SQL)
-- can create desk invites (see create_invite), so nobody can make themselves desk staff.

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

  -- A desk invite also turns on desk access for this person.
  if v_invite.role = 'desk' then
    update profiles p set is_desk = true where p.user_id = p_user;
  end if;
  return v_invite.workspace_id;
end;
$$;

revoke all on function public.redeem_invite(text, uuid) from public, anon, authenticated;
