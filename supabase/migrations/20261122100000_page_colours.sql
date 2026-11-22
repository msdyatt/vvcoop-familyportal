-- The page's colours (issue #140, follow-on): the ink (navy today: text, primary buttons, selected tabs, the Admin
-- band), the light theme's grounds (page, cards, inputs, panels) and the dark theme's grounds.
--
-- The rule that keeps every combination readable (lib/coop-theme.ts checkInk / checkGround / checkNight, mirrored by
-- private.coop_page_problems): the ink is at least as deep as navy, the light grounds at least as light as the Veritas
-- ones, and the dark grounds at least as deep as the Veritas night. Every contrast check in the portal is a dark colour
-- against a light one, so moving them further apart only adds contrast, for any palette. Null means the Veritas colours.

alter table public.coop_settings
  add column ink text check (ink is null or ink ~ '^#[0-9a-f]{6}$'),
  add column ink_id text not null default 'navy' check (ink_id ~ '^[a-z][a-z0-9-]{1,30}$'),
  add column ground jsonb,
  add column ground_id text not null default 'parchment' check (ground_id ~ '^[a-z][a-z0-9-]{1,30}$'),
  add column night jsonb,
  add column night_id text not null default 'navy-night' check (night_id ~ '^[a-z][a-z0-9-]{1,30}$');

-- Every reason the page's colours cannot be used, in plain words; empty when they can.
create or replace function private.coop_page_problems(p_ink text, p_ground jsonb, p_night jsonb)
returns text[]
language plpgsql immutable set search_path to ''
as $function$
declare
  v_problems text[] := '{}';
  r record;
begin
  if p_ink is not null then
    if p_ink !~ '^#[0-9a-f]{6}$' then
      v_problems := v_problems || 'Choose an ink colour.'::text;
    elsif private.hex_luminance(p_ink) > private.hex_luminance('#0b2a3d') + 1e-9 then
      v_problems := v_problems || 'This colour is too light for text and buttons: it needs to be at least as deep as the portal''s navy. Choose a darker shade.'::text;
    end if;
  end if;

  if p_ground is not null then
    if jsonb_typeof(p_ground) <> 'object'
       or exists (select 1 from unnest(array['ground', 'surface', 'sunken', 'panel']) k where coalesce(p_ground ->> k, '') !~ '^#[0-9a-f]{6}$')
       or exists (select 1 from jsonb_object_keys(p_ground) k where k not in ('ground', 'surface', 'sunken', 'panel')) then
      v_problems := v_problems || 'Choose a page colour.'::text;
    else
      for r in select * from (values ('ground', '#faf7f1', 'page'), ('surface', '#fffdf9', 'card'), ('sunken', '#f2eee5', 'input'), ('panel', '#e6e9e2', 'panel')) as t(k, veritas, word) loop
        if private.hex_luminance(p_ground ->> r.k) + 1e-9 < private.hex_luminance(r.veritas) then
          v_problems := v_problems || format('The %s colour is too dark for the light theme: text needs it at least as light as the portal''s own. Choose a paler tint.', r.word);
        end if;
      end loop;
    end if;
  end if;

  if p_night is not null then
    if jsonb_typeof(p_night) <> 'object'
       or exists (select 1 from unnest(array['canvas', 'surface', 'sunken', 'panel', 'band', 'field']) k where coalesce(p_night ->> k, '') !~ '^#[0-9a-f]{6}$')
       or exists (select 1 from jsonb_object_keys(p_night) k where k not in ('canvas', 'surface', 'sunken', 'panel', 'band', 'field')) then
      v_problems := v_problems || 'Choose a dark theme.'::text;
    else
      for r in select * from (values ('canvas', '#08202f', 'page'), ('surface', '#0e3045', 'card'), ('sunken', '#061a27', 'input'),
                                     ('panel', '#143a45', 'panel'), ('band', '#0d3a57', 'band'), ('field', '#0b2a3d', 'field')) as t(k, veritas, word) loop
        if private.hex_luminance(p_night ->> r.k) > private.hex_luminance(r.veritas) + 1e-9 then
          v_problems := v_problems || format('The dark theme''s %s colour is too light: light text needs it at least as deep as the portal''s own night.', r.word);
        end if;
      end loop;
    end if;
  end if;
  return v_problems;
end;
$function$;
revoke all on function private.coop_page_problems(text, jsonb, jsonb) from public, anon;

-- Saves the ink, the light grounds and the dark grounds. A null colour means the Veritas one (and its id is reset).
create or replace function public.admin_save_coop_page(
  p_ink_id text, p_ink text, p_ground_id text, p_ground jsonb, p_night_id text, p_night jsonb)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_brand_admin();
  v_ink text := lower(nullif(btrim(coalesce(p_ink, '')), ''));
  v_ground jsonb;
  v_night jsonb;
  v_problems text[];
begin
  if coalesce(p_ink_id, '') !~ '^[a-z][a-z0-9-]{1,30}$' or coalesce(p_ground_id, '') !~ '^[a-z][a-z0-9-]{1,30}$'
     or coalesce(p_night_id, '') !~ '^[a-z][a-z0-9-]{1,30}$' then
    raise exception 'Choose the ink, page and dark theme from the lists.';
  end if;
  if p_ground is not null then select jsonb_object_agg(k, lower(v)) into v_ground from jsonb_each_text(p_ground) as e(k, v); end if;
  if p_night is not null then select jsonb_object_agg(k, lower(v)) into v_night from jsonb_each_text(p_night) as e(k, v); end if;
  v_problems := private.coop_page_problems(v_ink, v_ground, v_night);
  if cardinality(v_problems) > 0 then
    raise exception 'These colours cannot be used: %', array_to_string(v_problems, ' ');
  end if;

  update public.coop_settings set
    ink = v_ink, ink_id = case when v_ink is null then 'navy' else p_ink_id end,
    ground = v_ground, ground_id = case when v_ground is null then 'parchment' else p_ground_id end,
    night = v_night, night_id = case when v_night is null then 'navy-night' else p_night_id end,
    updated_at = now(), updated_by = v_actor
  where id = 'coop';

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_page_colours_updated', 'coop_settings', 'coop',
    jsonb_build_object('ink', coalesce(v_ink, 'navy'), 'page', coalesce(v_ground ->> 'ground', 'parchment'), 'night', coalesce(v_night ->> 'canvas', 'navy night')));
end;
$function$;
revoke all on function public.admin_save_coop_page(text, text, text, jsonb, text, jsonb) from public, anon;
grant execute on function public.admin_save_coop_page(text, text, text, jsonb, text, jsonb) to authenticated;

-- ---- back to the Veritas Village look: the page's colours go too ---------------------------------------------------
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
    ink = null, ink_id = 'navy', ground = null, ground_id = 'parchment', night = null, night_id = 'navy-night',
    whimsy = '{"greeting":true,"village":true,"season":"auto","marker":"diamond","quill":true,"motion":true}'::jsonb,
    logo_light_path = null, logo_dark_path = null, mark_light_path = null, mark_dark_path = null, logo_ratio = null,
    updated_at = now(), updated_by = v_actor
  where id = 'coop';
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_appearance_reset', 'coop_settings', 'coop', '{}'::jsonb);
end;
$function$;
