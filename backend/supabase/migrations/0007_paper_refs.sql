-- 0007: paper numbers handed out by the server.
--
-- A paper's ref (JL-EXP-1116-01) is the stem for its kind and day plus a number. Each computer used to pick the next
-- number from the papers it had seen, so two computers of one house building a first paper the same day could both
-- take JL-EXP-1116-01. reserve_paper_ref gives each first build its own number:
--   * reserve_paper_ref(house, stem, floor) returns the next number for that stem in that house, at least floor + 1
--     (floor: the highest number the computer has seen), and never the same number twice.
--   * only people who may change the house's records (owners, preparers, desk) get numbers; the table is not readable
--     or writable directly.
-- The app falls back to its own numbering while this function is missing, so this migration can go in at any time.
-- Safe to run more than once.

create table if not exists public.paper_refs (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  stem         text not null,             -- 'JL-EXP-1116-'
  last         integer not null check (last >= 0),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, stem)
);
alter table public.paper_refs enable row level security;
revoke all on table public.paper_refs from anon, authenticated;
grant all on table public.paper_refs to service_role;

create or replace function public.reserve_paper_ref(p_workspace uuid, p_stem text, p_floor integer default 0)
returns integer
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_floor integer := greatest(coalesce(p_floor, 0), 0);
  v_next integer;
begin
  if auth.uid() is null or not can_write(p_workspace) then
    raise exception 'You cannot build papers for this house.' using errcode = '42501';
  end if;
  if p_stem is null or p_stem !~ '^JL-[A-Z0-9]{2,4}-[0-9]{4}-$' then
    raise exception 'That is not a paper number.' using errcode = '22023';
  end if;
  insert into paper_refs as r (workspace_id, stem, last)
  values (p_workspace, p_stem, v_floor + 1)
  on conflict (workspace_id, stem) do update
    set last = greatest(r.last, v_floor) + 1, updated_at = now()
  returning r.last into v_next;
  return v_next;
end;
$$;
revoke all on function public.reserve_paper_ref(uuid, text, integer) from public, anon;
grant execute on function public.reserve_paper_ref(uuid, text, integer) to authenticated;
