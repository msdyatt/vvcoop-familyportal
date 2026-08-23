-- Opens first_name to family self-editing too -- "what they go by" is a
-- routine correction (nickname, a fixed typo), not something that should
-- need an administrator. last_name stays administrator-only: it's the field
-- the household-surname-sync trigger drives across every child, so changing
-- it has effects beyond the one child being edited.
create or replace function private.restrict_family_child_update()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  if private.has_role('admin') then return new; end if;

  if new.last_name is distinct from old.last_name
    or new.last_initial is distinct from old.last_initial
    or new.last_name_override is distinct from old.last_name_override
    or new.active is distinct from old.active
    or new.family_id is distinct from old.family_id
  then
    raise exception 'Families may update a child''s name, photo, birthdate, and grade only.';
  end if;

  return new;
end;
$$;
