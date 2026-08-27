-- Lets a family update their own child's photo, birthdate, and grade
-- directly, instead of needing to ask an administrator for something this
-- routine.
--
-- RLS alone can't restrict an UPDATE to specific columns -- USING/WITH CHECK
-- see the proposed new row, not a diff against the old one -- so a trigger
-- does the fencing: a non-admin update that touches anything other than
-- avatar_path, birthdate, age_band, or age_band_override is rejected outright
-- rather than silently ignored, so a family member gets a clear error instead
-- of a change that quietly didn't do what they expected. Everything else
-- about a child (name, active status, which household they belong to) stays
-- administrator-only, unchanged from before.
create policy children_family_update on public.children
  for update to authenticated
  using (private.has_child_family_access(id))
  with check (private.has_child_family_access(id));

create or replace function private.restrict_family_child_update()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  if private.has_role('admin') then return new; end if;

  if new.first_name is distinct from old.first_name
    or new.last_name is distinct from old.last_name
    or new.last_initial is distinct from old.last_initial
    or new.last_name_override is distinct from old.last_name_override
    or new.active is distinct from old.active
    or new.family_id is distinct from old.family_id
  then
    raise exception 'Families may update a child''s photo, birthdate, and grade only.';
  end if;

  return new;
end;
$$;

drop trigger if exists children_family_update_guard on public.children;
create trigger children_family_update_guard
  before update on public.children
  for each row execute function private.restrict_family_child_update();
