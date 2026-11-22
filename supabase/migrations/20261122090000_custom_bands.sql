-- Your own header and sidebar colours, and more ready-made palettes (issue #140, follow-on).
--
-- A band of any colour: the colour itself, its text (cream or navy, whichever reads better) and a deep night version
-- with cream text for the dark theme. The page works the colours out (lib/coop-theme.ts bandFamily); they are checked
-- here before they are saved (private.coop_band_problems, the same rules as checkBand): 4.5:1 for the text by day
-- and by night. Admin keeps its navy band whatever is chosen.

-- ---- the colours -----------------------------------------------------------------------------------------------------
alter table public.coop_settings
  add column header_band jsonb,
  add column sidebar_band jsonb;

alter table public.coop_settings drop constraint if exists coop_settings_header_style_check;
alter table public.coop_settings drop constraint if exists coop_settings_sidebar_style_check;
alter table public.coop_settings
  add constraint coop_settings_header_style_check check (header_style in ('plain', 'tint', 'ink', 'accent', 'custom')),
  add constraint coop_settings_sidebar_style_check check (sidebar_style in ('plain', 'tint', 'ink', 'accent', 'custom')),
  add constraint coop_settings_header_custom_check check (header_style <> 'custom' or header_band is not null),
  add constraint coop_settings_sidebar_custom_check check (sidebar_style <> 'custom' or sidebar_band is not null);

-- Every reason a band cannot be used, in plain words; empty when it can. Mirrors lib/coop-theme.ts checkBand.
create or replace function private.coop_band_problems(p_band jsonb)
returns text[]
language plpgsql immutable set search_path to ''
as $function$
declare
  v_problems text[] := '{}';
  v_day double precision;
  v_night double precision;
begin
  if p_band is null or jsonb_typeof(p_band) <> 'object'
     or exists (select 1 from unnest(array['bg', 'fg', 'bg_night', 'fg_night']) k where coalesce(p_band ->> k, '') !~ '^#[0-9a-f]{6}$')
     or exists (select 1 from jsonb_object_keys(p_band) k where k not in ('bg', 'fg', 'bg_night', 'fg_night')) then
    return array['Choose a colour.'];
  end if;
  if p_band ->> 'fg' not in ('#faf7f1', '#0b2a3d') then
    v_problems := v_problems || 'The text on it has to be cream or navy.'::text;
  end if;
  if p_band ->> 'fg_night' <> '#faf7f1' then
    v_problems := v_problems || 'The text on it in the dark theme has to be cream.'::text;
  end if;
  v_day := private.contrast_ratio(p_band ->> 'fg', p_band ->> 'bg');
  v_night := private.contrast_ratio(p_band ->> 'fg_night', p_band ->> 'bg_night');
  if v_day + 1e-9 < 4.5 then
    v_problems := v_problems || format('Text would be hard to read on this colour (%s:1, needs 4.5:1). Choose a lighter or darker shade.',
      to_char(floor(v_day * 100) / 100, 'FM990.00'));
  end if;
  if v_night + 1e-9 < 4.5 then
    v_problems := v_problems || format('Text would be hard to read on it in the dark theme (%s:1, needs 4.5:1).',
      to_char(floor(v_night * 100) / 100, 'FM990.00'));
  end if;
  return v_problems;
end;
$function$;
revoke all on function private.coop_band_problems(jsonb) from public, anon;

-- ---- saving the text font, header, sidebar and small touches: now with the two colours -----------------------------
-- p_header_band / p_sidebar_band are kept even when that band is not "Your own colour", so switching back finds them.
drop function if exists public.admin_save_coop_style(text, text, text, jsonb);
create or replace function public.admin_save_coop_style(
  p_body_font text, p_header_style text, p_sidebar_style text, p_whimsy jsonb, p_header_band jsonb, p_sidebar_band jsonb)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_brand_admin();
  v_whimsy jsonb;
  v_header jsonb;
  v_sidebar jsonb;
  v_problems text[];
begin
  if coalesce(p_body_font, '') not in (
    'inter', 'system', 'atkinson', 'lexend', 'source-sans', 'open-sans', 'work-sans', 'nunito',
    'literata', 'source-serif', 'lora', 'merriweather') then
    raise exception 'Choose a text font from the list.';
  end if;
  if coalesce(p_header_style, '') not in ('plain', 'tint', 'ink', 'accent', 'custom') then
    raise exception 'Choose a header style from the list.';
  end if;
  if coalesce(p_sidebar_style, '') not in ('plain', 'tint', 'ink', 'accent', 'custom') then
    raise exception 'Choose a sidebar style from the list.';
  end if;
  if p_whimsy is null or jsonb_typeof(p_whimsy) <> 'object' then
    raise exception 'The small touches are missing.';
  end if;
  if exists (select 1 from jsonb_object_keys(p_whimsy) k where k not in ('greeting', 'village', 'season', 'marker', 'quill', 'motion')) then
    raise exception 'Unknown small touch.';
  end if;
  v_whimsy := '{"greeting":true,"village":true,"season":"auto","marker":"diamond","quill":true,"motion":true}'::jsonb || p_whimsy;

  if p_header_band is not null then
    select jsonb_object_agg(k, lower(v)) into v_header from jsonb_each_text(p_header_band) as e(k, v);
    v_problems := private.coop_band_problems(v_header);
    if cardinality(v_problems) > 0 then
      raise exception 'The header colour cannot be used: %', array_to_string(v_problems, ' ');
    end if;
  end if;
  if p_sidebar_band is not null then
    select jsonb_object_agg(k, lower(v)) into v_sidebar from jsonb_each_text(p_sidebar_band) as e(k, v);
    v_problems := private.coop_band_problems(v_sidebar);
    if cardinality(v_problems) > 0 then
      raise exception 'The sidebar colour cannot be used: %', array_to_string(v_problems, ' ');
    end if;
  end if;
  if p_header_style = 'custom' and v_header is null then raise exception 'Choose a colour for the header.'; end if;
  if p_sidebar_style = 'custom' and v_sidebar is null then raise exception 'Choose a colour for the sidebar.'; end if;

  begin
    update public.coop_settings set
      body_font = p_body_font, header_style = p_header_style, sidebar_style = p_sidebar_style, whimsy = v_whimsy,
      header_band = v_header, sidebar_band = v_sidebar,
      updated_at = now(), updated_by = v_actor
    where id = 'coop';
  exception when check_violation then
    raise exception 'One of the small touches has a value that is not on the list.';
  end;

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_style_updated', 'coop_settings', 'coop',
    jsonb_build_object('body_font', p_body_font, 'header_style', p_header_style, 'sidebar_style', p_sidebar_style, 'whimsy', v_whimsy,
      'header_colour', v_header ->> 'bg', 'sidebar_colour', v_sidebar ->> 'bg'));
end;
$function$;
revoke all on function public.admin_save_coop_style(text, text, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.admin_save_coop_style(text, text, text, jsonb, jsonb, jsonb) to authenticated;

-- ---- back to the Veritas Village look: the colours go too ----------------------------------------------------------
create or replace function public.admin_reset_coop_appearance()
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_brand_admin();
begin
  update public.coop_settings set
    palette_id = 'veritas',
    accent = private.default_coop_accent(),
    heading_font = 'playfair',
    body_font = 'inter',
    header_style = 'plain',
    sidebar_style = 'plain',
    header_band = null,
    sidebar_band = null,
    whimsy = '{"greeting":true,"village":true,"season":"auto","marker":"diamond","quill":true,"motion":true}'::jsonb,
    logo_light_path = null, logo_dark_path = null, mark_light_path = null, mark_dark_path = null, logo_ratio = null,
    updated_at = now(), updated_by = v_actor
  where id = 'coop';
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_appearance_reset', 'coop_settings', 'coop', '{}'::jsonb);
end;
$function$;

-- ---- more ready-made palettes members may be offered (lib/coop-theme.ts PALETTES; the test keeps them the same) -----
alter table public.coop_settings drop constraint if exists coop_settings_personal_palettes_check;
alter table public.coop_settings add constraint coop_settings_personal_palettes_check check (personal_palettes <@ array[
  'veritas', 'meadow', 'harbor', 'plum', 'teal', 'ochre', 'berry', 'rose', 'lavender', 'indigo', 'sky', 'slate', 'olive', 'marigold']::text[]);

create or replace function public.admin_set_personal_palettes(p_ids text[])
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_brand_admin();
  v_known text[] := array['veritas', 'meadow', 'harbor', 'plum', 'teal', 'ochre', 'berry', 'rose', 'lavender', 'indigo', 'sky', 'slate', 'olive', 'marigold'];
  v_ids text[];
begin
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
