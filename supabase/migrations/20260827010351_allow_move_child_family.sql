-- children_admin_write's RLS policy already lets an admin update any child
-- row, but the column-level grant from 20260820180000_admin_family_management.sql
-- never included family_id -- Postgres checks column privileges for UPDATE
-- separately from the row policy, so moving a child to another household was
-- silently blocked at the grant level even though the policy would have
-- allowed it. GRANT UPDATE (col) statements are additive, not a replacement
-- of the earlier list, so this only adds the one column.
grant update (family_id) on public.children to authenticated;
