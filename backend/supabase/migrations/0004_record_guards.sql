-- 0004: the database keeps the desk's decisions, signed papers and the audit trail as they were written.
--
-- The agents run on the house's own computers, so owners and preparers may write their house's records (0001).
-- Before this, that also let them write what only Jewel Labs or a signature should decide. Now, for anyone who is
-- not Jewel Labs desk staff (is_desk()), a trigger on records:
--   * keeps the desk's fields as the desk wrote them: shipments.deskApproved, and on papers approvedBy,
--     approvedAt, deskNote, heldBy and heldAt (whatever the app sends for them is replaced; nothing is refused,
--     so a computer saving an older copy does not undo the desk's work),
--   * refuses messages that speak as the desk (from.role 'desk', from 'desk' or kind 'desk'), and any change to or
--     removal of a desk message,
--   * papers: a version held for review stays held until Jewel Labs releases it; a signed or sent version keeps
--     its file, hash and signature (only the sending details may change, signed -> sent); a rebuild must keep the
--     signed version in the paper's history; a paper never goes back to an older version; signed or sent papers
--     cannot be removed,
--   * activity (the audit trail) is add-only: rows cannot be changed or removed,
--   * a record cannot be moved to another house, collection or id.
-- Storage: files under <house>/papers/ are write-once for everyone but desk staff (no replace, no delete).
--
-- What this cannot do: the compliance rules run in the app, so a writer can still save checks that pass, or build
-- a new version of a held paper as ready to sign (that is also how a house legitimately clears a hold after fixing
-- the papers). The database stamps who saved each row (records.updated_by), so such a change is on record.
--
-- Jewel Labs desk staff, the Edge Functions (service role) and the SQL editor are not limited. Safe to run again.

-- =====================================================================================================
-- Small helpers (pure jsonb)
-- =====================================================================================================

-- p_target with p_keys exactly as they are in p_source (present with their value, or absent).
create or replace function public.keep_fields(p_target jsonb, p_source jsonb, p_keys text[])
returns jsonb
language sql immutable
set search_path = public, pg_temp
as $$
  select (p_target - p_keys)
    || coalesce((select jsonb_object_agg(k, p_source -> k) from unnest(p_keys) k where p_source ? k), '{}'::jsonb);
$$;

-- p_target with every key of p_keys that has a value set to null.
create or replace function public.clear_fields(p_target jsonb, p_keys text[])
returns jsonb
language sql immutable
set search_path = public, pg_temp
as $$
  select p_target || coalesce(
    (select jsonb_object_agg(k, 'null'::jsonb) from unnest(p_keys) k where coalesce(p_target -> k, 'null'::jsonb) <> 'null'::jsonb),
    '{}'::jsonb);
$$;

-- A message that speaks as the Jewel Labs desk (the app shows these as "Jewel Labs").
create or replace function public.is_desk_message(p_data jsonb)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_data -> 'from' = '"desk"'::jsonb or p_data #>> '{from,role}' = 'desk' or p_data ->> 'kind' = 'desk', false);
$$;

create or replace function public.paper_version(p_data jsonb)
returns numeric
language sql immutable
set search_path = public, pg_temp
as $$
  select case when jsonb_typeof(p_data -> 'version') = 'number' then (p_data ->> 'version')::numeric else 0 end;
$$;

-- =====================================================================================================
-- Papers
-- =====================================================================================================

-- A change to a paper by someone who is not desk staff. Returns the paper as it is saved, or refuses.
create or replace function public.guard_paper_change(p_old jsonb, p_new jsonb)
returns jsonb
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  v_desk_fields constant text[] := array['approvedBy', 'approvedAt', 'deskNote', 'heldBy', 'heldAt'];
  v_sending constant text[] := array['status', 'sentTo', 'sentCc', 'sentAt', 'messageId', 'updatedAt'];
  v_signed constant text[] := array['signed', 'sent'];
  v_old_version numeric := paper_version(p_old);
  v_new_version numeric := paper_version(p_new);
  v_old_status text := p_old ->> 'status';
  v_new_status text := p_new ->> 'status';
  v_out jsonb;
begin
  if v_new_version < v_old_version then
    raise exception 'This paper already has a newer version (v%). Open it again to see it.', v_old_version;
  end if;

  if v_new_version = v_old_version then
    -- The desk's approval or hold of this version stays as the desk wrote it.
    v_out := keep_fields(p_new, p_old, v_desk_fields);
    if v_old_status = any (v_signed) then
      -- Signed: only the sending details may change, from signed to sent (or sent again).
      if not coalesce(v_new_status = any (v_signed), false)
         or (v_old_status = 'sent' and v_new_status is distinct from 'sent')
         or (v_out - v_sending) <> (p_old - v_sending) then
        raise exception 'A signed paper cannot be changed. Build a new version instead.';
      end if;
    elsif v_old_status = 'held_for_review' and v_new_status is distinct from 'held_for_review' then
      raise exception 'This paper is held for review. Only Jewel Labs can release it.';
    end if;
    return v_out;
  end if;

  -- A new version (a rebuild). A signed or sent version stays in the paper's history as it was signed.
  if v_old_status = any (v_signed) and not coalesce(p_new -> 'versions' @> jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
       'version', p_old -> 'version', 'status', p_old -> 'status', 'fileKey', p_old -> 'fileKey',
       'sha256', p_old -> 'sha256', 'signedBy', p_old -> 'signedBy', 'signedAt', p_old -> 'signedAt'))), false) then
    raise exception 'A new version must keep the signed version in the paper''s history.';
  end if;
  -- The desk approved the version it saw, not this one. An earlier hold stays on record.
  return keep_fields(clear_fields(p_new, array['approvedBy', 'approvedAt', 'deskNote']), p_old, array['heldBy', 'heldAt']);
end;
$$;

-- =====================================================================================================
-- The trigger
-- =====================================================================================================

-- security definer only so the helpers above need no grants; it reads nothing but the row and is_desk().
create or replace function public.guard_record()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or is_desk() then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.collection = 'activity' then
      raise exception 'The activity log cannot be changed.';
    elsif old.collection = 'messages' and is_desk_message(old.data) then
      raise exception 'A message from Jewel Labs cannot be removed.';
    elsif old.collection = 'papers' and old.data ->> 'status' in ('signed', 'sent') then
      raise exception 'A signed paper cannot be removed.';
    end if;
    return old;
  end if;

  if jsonb_typeof(new.data) <> 'object' then
    raise exception 'A record must be a JSON object.';
  end if;
  if new.collection = 'messages' and is_desk_message(new.data) then
    raise exception 'Only Jewel Labs can post messages as the desk.';
  end if;

  -- INSERT (also the first step of an upsert): no desk fields on a new record.
  if tg_op = 'INSERT' then
    if new.collection = 'shipments' then
      new.data := clear_fields(new.data, array['deskApproved']);
    elsif new.collection = 'papers' then
      new.data := clear_fields(new.data, array['approvedBy', 'approvedAt', 'deskNote', 'heldBy', 'heldAt']);
    end if;
    return new;
  end if;

  -- UPDATE
  if (new.workspace_id, new.collection, new.id) is distinct from (old.workspace_id, old.collection, old.id) then
    raise exception 'A record cannot be moved.';
  end if;
  if new.data = old.data then
    return new; -- the same record sent again (a retry)
  end if;
  if old.collection = 'activity' then
    raise exception 'The activity log cannot be changed.';
  elsif old.collection = 'messages' and is_desk_message(old.data) then
    raise exception 'A message from Jewel Labs cannot be changed.';
  elsif old.collection = 'shipments' then
    new.data := keep_fields(new.data, old.data, array['deskApproved']);
  elsif old.collection = 'papers' then
    new.data := guard_paper_change(old.data, new.data);
  end if;
  return new;
end;
$$;

-- Runs before jl_stamp_record (triggers fire in name order); a refusal stops the save.
create or replace trigger jl_guard_record
  before insert or update or delete on public.records
  for each row execute function public.guard_record();

-- Only the trigger uses these, so nobody needs to call them.
revoke all on function
  public.keep_fields(jsonb, jsonb, text[]), public.clear_fields(jsonb, text[]), public.is_desk_message(jsonb),
  public.paper_version(jsonb), public.guard_paper_change(jsonb, jsonb), public.guard_record()
from public, anon, authenticated;

-- =====================================================================================================
-- Storage: generated papers are write-once (each version and each signature gets its own file name)
-- =====================================================================================================

drop policy if exists "jl documents: writers replace" on storage.objects;
create policy "jl documents: writers replace" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents' and public.can_write(public.workspace_from_path(name))
    and (split_part(name, '/', 2) <> 'papers' or (select public.is_desk()))
  )
  with check (
    bucket_id = 'documents' and public.can_write(public.workspace_from_path(name))
    and (split_part(name, '/', 2) <> 'papers' or (select public.is_desk()))
  );

drop policy if exists "jl documents: writers delete" on storage.objects;
create policy "jl documents: writers delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents' and public.can_write(public.workspace_from_path(name))
    and (split_part(name, '/', 2) <> 'papers' or (select public.is_desk()))
  );
