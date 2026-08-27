-- The Families tab's new "Move" control reassigns a child's family_id, but
-- neither existing surname trigger covers that case:
-- sync_children_last_name() only fires when a FAMILY's own last_name changes,
-- and default_child_last_name() only fires on a child INSERT. A moved child
-- without last_name_override kept displaying their old household's surname
-- everywhere (family card, printable rosters, CSV exports) until someone
-- happened to re-save the new family's name -- contradicting this table's own
-- stated invariant that a non-overridden child's surname always follows its
-- current household.
create or replace function private.sync_moved_child_last_name()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.family_id is distinct from old.family_id and not new.last_name_override then
    select f.last_name into new.last_name from public.families f where f.id = new.family_id;
  end if;
  return new;
end;
$$;
revoke all on function private.sync_moved_child_last_name() from public, anon, authenticated;

drop trigger if exists on_child_family_change_sync_last_name on public.children;
create trigger on_child_family_change_sync_last_name
before update of family_id on public.children
for each row execute function private.sync_moved_child_last_name();
