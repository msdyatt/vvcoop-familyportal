-- Personal appearance (issue #140, part 2): which ready-made palettes each person may pick for themselves.
--
-- A person's own choices (accent, larger text, and Light/Dark/System) are kept in their own row of
-- public.user_nav_prefs (prefs.accent, prefs.textSize, prefs.theme), which RLS already limits to that person; no
-- change is needed there. This migration only adds the co-op's list of allowed palettes and the admin function that
-- sets it. Only ready-made palettes can be offered: each has passed every contrast check (lib/coop-theme.ts PALETTES,
-- tests/theme-contrast.test.mjs). The ids below must match that list (the test checks).

alter table public.coop_settings
  add column if not exists personal_palettes text[] not null
    default '{veritas,meadow,harbor,plum,teal,ochre}'
    check (personal_palettes <@ array['veritas', 'meadow', 'harbor', 'plum', 'teal', 'ochre']::text[]);

create or replace function public.admin_set_personal_palettes(p_ids text[])
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_brand_admin();
  v_known text[] := array['veritas', 'meadow', 'harbor', 'plum', 'teal', 'ochre'];
  v_ids text[];
begin
  -- Kept in the order of the ready-made list, without repeats.
  select coalesce(array_agg(k order by array_position(v_known, k)), '{}') into v_ids
  from unnest(v_known) k where k = any (coalesce(p_ids, '{}'));
  if exists (select 1 from unnest(coalesce(p_ids, '{}')) x where x is null or x <> all (v_known)) then
    raise exception 'Only the ready-made palettes can be offered to members.';
  end if;

  update public.coop_settings set personal_palettes = v_ids, updated_at = now(), updated_by = v_actor where id = 'coop';

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_personal_palettes_updated', 'coop_settings', 'coop', jsonb_build_object('palettes', v_ids));
end;
$function$;

revoke all on function public.admin_set_personal_palettes(text[]) from public, anon;
grant execute on function public.admin_set_personal_palettes(text[]) to authenticated;
