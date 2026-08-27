-- The narrow `revoke update (calendar_token) on public.profiles from
-- authenticated` in the previous migration turned out to be a no-op: this
-- table already had a blanket table-level UPDATE grant to `authenticated`
-- (confirmed via has_column_privilege() still returning true afterward), and
-- a broader table-level grant is not narrowed by a column-level revoke --
-- exactly the "column grant" trap this project has hit before (see
-- HANDOFF.md). The fix is the same one used elsewhere in this project: revoke
-- the blanket grant, then re-grant only the columns self-service actually
-- writes (confirmed by grepping every `.from("profiles").update(...)` call
-- in the app: avatar_path, display_name, phone, emergency_contact_name,
-- emergency_contact_phone, status, updated_at -- nothing else, from either
-- the self-service or admin-triggered client code).
--
-- id/email/created_at are covered by both this grant (absent) and the
-- self-update trigger (which still blocks them explicitly, in case a future
-- grant is ever widened again without re-reading this file). calendar_token
-- is covered by this grant alone -- it's deliberately left out of the
-- trigger's own checks so regenerate_calendar_token() (SECURITY DEFINER,
-- runs as its owner, unaffected by a grant made to `authenticated`) keeps
-- working as the one legitimate way to change it.
revoke update on public.profiles from authenticated;
grant update (avatar_path, display_name, phone, emergency_contact_name, emergency_contact_phone, status, updated_at)
  on public.profiles to authenticated;
