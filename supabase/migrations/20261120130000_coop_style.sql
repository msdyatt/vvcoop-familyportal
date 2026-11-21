-- More of the co-op's look (issue #140, follow-on): many more heading fonts, a body text font, how the header and the
-- sidebar are drawn, and the sidebar's small touches. lib/coop-theme.ts (HEADING_FONTS, BODY_FONTS, BAND_STYLES,
-- WHIMSY_*) holds the same lists; tests/coop-theme.test.mjs checks the two agree.
--
-- The header and sidebar styles only pair colours that are already checked (the accent's tint with its ink, the navy
-- band and the accent's deep fill with cream), so there is no new contrast check here. Admin keeps its navy band.

-- ---- heading fonts: the longer list ----------------------------------------------------------------------------------
alter table public.coop_settings drop constraint if exists coop_settings_heading_font_check;
alter table public.coop_settings add constraint coop_settings_heading_font_check check (heading_font in (
  'playfair', 'georgia', 'book', 'eb-garamond', 'cormorant', 'lora', 'merriweather', 'source-serif', 'literata', 'alegreya',
  'fraunces', 'comfortaa', 'quicksand', 'nunito', 'caveat', 'dancing',
  'sans', 'montserrat', 'raleway', 'josefin', 'lexend', 'work-sans'));

-- ---- the new settings ------------------------------------------------------------------------------------------------
alter table public.coop_settings
  add column body_font text not null default 'inter' check (body_font in (
    'inter', 'system', 'atkinson', 'lexend', 'source-sans', 'open-sans', 'work-sans', 'nunito',
    'literata', 'source-serif', 'lora', 'merriweather')),
  add column header_style text not null default 'plain' check (header_style in ('plain', 'tint', 'ink', 'accent')),
  add column sidebar_style text not null default 'plain' check (sidebar_style in ('plain', 'tint', 'ink', 'accent')),
  add column whimsy jsonb not null default
    '{"greeting":true,"village":true,"season":"auto","marker":"diamond","quill":true,"motion":true}'::jsonb
    check (
      jsonb_typeof(whimsy) = 'object'
      and whimsy ?& array['greeting', 'village', 'season', 'marker', 'quill', 'motion']
      and jsonb_typeof(whimsy->'greeting') = 'boolean'
      and jsonb_typeof(whimsy->'village') = 'boolean'
      and jsonb_typeof(whimsy->'quill') = 'boolean'
      and jsonb_typeof(whimsy->'motion') = 'boolean'
      and whimsy->>'season' in ('auto', 'autumn', 'winter', 'spring', 'summer', 'none')
      and whimsy->>'marker' in ('diamond', 'star', 'heart', 'leaf', 'dot')
    );

-- ---- saving the name, palette and heading font: the same as before, with the longer font list ---------------------
create or replace function public.admin_save_coop_settings(
  p_name text, p_palette_id text, p_accent jsonb, p_heading_font text, p_support_email text, p_support_phone text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_brand_admin();
  v_name text := btrim(coalesce(p_name, ''));
  v_email text := nullif(btrim(coalesce(p_support_email, '')), '');
  v_phone text := nullif(btrim(coalesce(p_support_phone, '')), '');
  v_accent jsonb;
  v_problems text[];
begin
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Give the co-op a name of up to 80 characters.';
  end if;
  if coalesce(p_palette_id, '') !~ '^[a-z][a-z0-9-]{1,30}$' then
    raise exception 'Choose a palette.';
  end if;
  if coalesce(p_heading_font, '') not in (
    'playfair', 'georgia', 'book', 'eb-garamond', 'cormorant', 'lora', 'merriweather', 'source-serif', 'literata', 'alegreya',
    'fraunces', 'comfortaa', 'quicksand', 'nunito', 'caveat', 'dancing',
    'sans', 'montserrat', 'raleway', 'josefin', 'lexend', 'work-sans') then
    raise exception 'Choose a heading font from the list.';
  end if;
  if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'The support email does not look like an email address.';
  end if;
  if v_phone is not null and v_phone !~ '^[0-9 +().-]{7,40}$' then
    raise exception 'The support phone number can only have digits, spaces and + ( ) . -';
  end if;
  select jsonb_object_agg(k, lower(v)) into v_accent from jsonb_each_text(coalesce(p_accent, '{}'::jsonb)) as e(k, v);
  v_problems := private.coop_accent_problems(v_accent);
  if cardinality(v_problems) > 0 then
    raise exception 'This palette cannot be used: %', array_to_string(v_problems, ' ')
      using hint = 'Choose a darker or lighter shade, or one of the ready-made palettes.';
  end if;

  update public.coop_settings set
    name = v_name, palette_id = p_palette_id, accent = v_accent, heading_font = p_heading_font,
    support_email = v_email, support_phone = v_phone, updated_at = now(), updated_by = v_actor
  where id = 'coop';

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_settings_updated', 'coop_settings', 'coop',
    jsonb_build_object('name', v_name, 'palette_id', p_palette_id, 'accent', v_accent->>'accent', 'heading_font', p_heading_font));
end;
$function$;

-- ---- saving the body font, header, sidebar and small touches --------------------------------------------------------
-- p_whimsy may leave keys out (they keep their defaults) but may not add any; the table's check does the rest.
create or replace function public.admin_save_coop_style(
  p_body_font text, p_header_style text, p_sidebar_style text, p_whimsy jsonb)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_brand_admin();
  v_whimsy jsonb;
begin
  if coalesce(p_body_font, '') not in (
    'inter', 'system', 'atkinson', 'lexend', 'source-sans', 'open-sans', 'work-sans', 'nunito',
    'literata', 'source-serif', 'lora', 'merriweather') then
    raise exception 'Choose a text font from the list.';
  end if;
  if coalesce(p_header_style, '') not in ('plain', 'tint', 'ink', 'accent') then
    raise exception 'Choose a header style from the list.';
  end if;
  if coalesce(p_sidebar_style, '') not in ('plain', 'tint', 'ink', 'accent') then
    raise exception 'Choose a sidebar style from the list.';
  end if;
  if p_whimsy is null or jsonb_typeof(p_whimsy) <> 'object' then
    raise exception 'The small touches are missing.';
  end if;
  if exists (select 1 from jsonb_object_keys(p_whimsy) k where k not in ('greeting', 'village', 'season', 'marker', 'quill', 'motion')) then
    raise exception 'Unknown small touch.';
  end if;
  v_whimsy := '{"greeting":true,"village":true,"season":"auto","marker":"diamond","quill":true,"motion":true}'::jsonb || p_whimsy;

  begin
    update public.coop_settings set
      body_font = p_body_font, header_style = p_header_style, sidebar_style = p_sidebar_style, whimsy = v_whimsy,
      updated_at = now(), updated_by = v_actor
    where id = 'coop';
  exception when check_violation then
    raise exception 'One of the small touches has a value that is not on the list.';
  end;

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_style_updated', 'coop_settings', 'coop',
    jsonb_build_object('body_font', p_body_font, 'header_style', p_header_style, 'sidebar_style', p_sidebar_style, 'whimsy', v_whimsy));
end;
$function$;

-- ---- back to the Veritas Village look: now also the text font, header, sidebar and small touches -------------------
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
    whimsy = '{"greeting":true,"village":true,"season":"auto","marker":"diamond","quill":true,"motion":true}'::jsonb,
    logo_light_path = null, logo_dark_path = null, mark_light_path = null, mark_dark_path = null, logo_ratio = null,
    updated_at = now(), updated_by = v_actor
  where id = 'coop';
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_appearance_reset', 'coop_settings', 'coop', '{}'::jsonb);
end;
$function$;

revoke all on function public.admin_save_coop_style(text, text, text, jsonb) from public, anon;
grant execute on function public.admin_save_coop_style(text, text, text, jsonb) to authenticated;
