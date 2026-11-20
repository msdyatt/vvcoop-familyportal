-- The co-op's own settings and look (issue #140, docs/theming.md "Co-op theme").
--
-- One row. Read by everyone, signed in or not: the sign-in page shows the co-op's name and logo before anyone has
-- signed in, and nothing here is private (it is what the portal shows on every page). Written only through the
-- admin functions below, which check the admin role, the second factor and that the caller is not a reviewer.
--
-- The accent palette is ten colours (lib/coop-theme.ts ACCENT_KEYS). Before one is saved it is checked for contrast
-- against the role backgrounds it is drawn on, with the same list and limits the app uses
-- (lib/coop-theme.ts ACCENT_CHECKS): a palette that would make text or lines too faint is refused, with the reason.
-- Alert and error colours are not part of it.
--
-- Logos live in the public bucket coop-brand (they appear in emails and on the sign-in page, so they must load
-- without a session): PNG, JPEG or WebP, at most 1 MB. Only a brand admin can add, replace or remove them.

-- --- the settings ------------------------------------------------------------------------------------------------
-- The Veritas Village palette (lib/coop-theme.ts VERITAS_ACCENT): the default, and what "Reset" goes back to.
create or replace function private.default_coop_accent()
returns jsonb
language sql immutable set search_path to ''
as $function$
  select '{"accent": "#bb6141", "accent_text": "#a85539", "accent_on_ink": "#d7a590", "accent_deep": "#6b3826",
           "accent_tint": "#efd9cd", "accent_tint_ink": "#4a2417", "night_ink": "#e8a98d", "night_fill": "#a85539",
           "night_tint": "#5b3324", "night_tint_ink": "#f6d9cb"}'::jsonb;
$function$;
revoke all on function private.default_coop_accent() from public, anon;

create table public.coop_settings (
  id text primary key default 'coop' check (id = 'coop'),
  name text not null default 'Veritas Village' check (char_length(btrim(name)) between 1 and 80),
  palette_id text not null default 'veritas' check (palette_id ~ '^[a-z][a-z0-9-]{1,30}$'),
  accent jsonb not null default private.default_coop_accent(),
  heading_font text not null default 'playfair' check (heading_font in ('playfair', 'georgia', 'book', 'sans')),
  logo_light_path text,
  logo_dark_path text,
  mark_light_path text,
  mark_dark_path text,
  -- The light lockup's width / height, so the co-op's own logo keeps its shape. Null: the bundled lockup's.
  logo_ratio numeric check (logo_ratio is null or logo_ratio between 1 and 6),
  support_email text check (support_email is null or support_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  support_phone text check (support_phone is null or support_phone ~ '^[0-9 +().-]{7,40}$'),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.coop_settings (id) values ('coop') on conflict do nothing;

alter table public.coop_settings enable row level security;
create policy coop_settings_read on public.coop_settings for select to anon, authenticated using (true);
revoke all on public.coop_settings from public, anon, authenticated;
grant select on public.coop_settings to anon, authenticated, service_role;

-- --- contrast -------------------------------------------------------------------------------------------------------
-- WCAG relative luminance and contrast ratio, for '#rrggbb' colours.
create or replace function private.hex_luminance(p_hex text)
returns double precision
language sql immutable set search_path to ''
as $function$
  with c as (
    select ('x' || substr(p_hex, 2, 2))::bit(8)::int / 255.0 as r,
           ('x' || substr(p_hex, 4, 2))::bit(8)::int / 255.0 as g,
           ('x' || substr(p_hex, 6, 2))::bit(8)::int / 255.0 as b
  ), l as (
    select case when r <= 0.03928 then r / 12.92 else power((r + 0.055) / 1.055, 2.4) end as r,
           case when g <= 0.03928 then g / 12.92 else power((g + 0.055) / 1.055, 2.4) end as g,
           case when b <= 0.03928 then b / 12.92 else power((b + 0.055) / 1.055, 2.4) end as b
    from c
  )
  select 0.2126 * r + 0.7152 * g + 0.0722 * b from l;
$function$;

create or replace function private.contrast_ratio(p_a text, p_b text)
returns double precision
language sql immutable set search_path to ''
as $function$
  select (greatest(a, b) + 0.05) / (least(a, b) + 0.05)
  from (select private.hex_luminance(p_a) as a, private.hex_luminance(p_b) as b) x;
$function$;

-- Every reason a palette cannot be used, in plain words; empty when it can. Mirrors lib/coop-theme.ts checkAccent.
create or replace function private.coop_accent_problems(p_accent jsonb)
returns text[]
language plpgsql immutable set search_path to ''
as $function$
declare
  v_keys text[] := array['accent', 'accent_text', 'accent_on_ink', 'accent_deep', 'accent_tint', 'accent_tint_ink',
                         'night_ink', 'night_fill', 'night_tint', 'night_tint_ink'];
  v_key text;
  v_problems text[] := '{}';
  v_ratio double precision;
  r record;
begin
  if p_accent is null or jsonb_typeof(p_accent) <> 'object' then
    return array['Choose a palette.'];
  end if;
  foreach v_key in array v_keys loop
    if coalesce(p_accent ->> v_key, '') !~ '^#[0-9a-f]{6}$' then
      v_problems := v_problems || format('The palette is missing its %s colour.', replace(v_key, '_', ' '));
    end if;
  end loop;
  if exists (select 1 from jsonb_object_keys(p_accent) k where k <> all (v_keys)) then
    v_problems := v_problems || 'The palette has a colour this version does not know.'::text;
  end if;
  if cardinality(v_problems) > 0 then return v_problems; end if;

  -- [colour, what it is drawn with, minimum, where] (lib/coop-theme.ts ACCENT_CHECKS and TINT_CHECKS)
  for r in
    select * from (values
      ('accent', '#faf7f1', 3.0, 'lines and large headings on the page'),
      ('accent', '#fffdf9', 3.0, 'lines and marks on cards'),
      ('accent', '#08202f', 3.0, 'lines and borders on the page in the dark theme'),
      ('accent', '#0e3045', 3.0, 'lines and borders on cards in the dark theme'),
      ('accent_text', '#faf7f1', 4.5, 'small accent text on the page'),
      ('accent_text', '#fffdf9', 4.5, 'small accent text on cards'),
      ('accent_text', '#ffffff', 4.5, 'white labels on accent chips'),
      ('accent_text', '#faf7f1', 4.5, 'labels on class events in the calendar'),
      ('accent_on_ink', '#0b2a3d', 4.5, 'accent text on navy bands and buttons'),
      ('accent_on_ink', '#0d3a57', 4.5, 'accent text on bands in the dark theme'),
      ('accent_on_ink', '#08202f', 4.5, 'small accent text in the dark theme'),
      ('accent_on_ink', '#0e3045', 4.5, 'small accent text on cards in the dark theme'),
      ('accent_deep', '#faf7f1', 4.5, 'the label on today''s date'),
      ('night_ink', '#08202f', 3.0, 'headings and marks in the dark theme'),
      ('night_ink', '#0e3045', 3.0, 'marks on cards in the dark theme'),
      ('night_fill', '#faf7f1', 4.5, 'button labels in the dark theme'),
      ('night_fill', '#ffffff', 4.5, 'white button labels in the dark theme'),
      ('accent_tint_ink', '@accent_tint', 4.5, 'the selected tab on Android'),
      ('night_tint_ink', '@night_tint', 4.5, 'the selected tab on Android in the dark theme')
    ) as t(colour, ground, need, place)
  loop
    v_ratio := private.contrast_ratio(p_accent ->> r.colour,
      case when r.ground like '@%' then p_accent ->> substr(r.ground, 2) else r.ground end);
    if v_ratio + 1e-9 < r.need then
      v_problems := v_problems || format('Too close to its background for %s (%s:1, needs %s:1).',
        r.place, to_char(floor(v_ratio * 100) / 100, 'FM990.00'), rtrim(rtrim(r.need::numeric::text, '0'), '.'));
    end if;
  end loop;
  return v_problems;
end;
$function$;

-- --- who may change it --------------------------------------------------------------------------------------------
create or replace function private.require_brand_admin()
returns uuid
language plpgsql stable security definer set search_path to ''
as $function$
declare v uuid := (select auth.uid());
begin
  if v is null or not private.has_role('admin') or private.is_demo_user() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if not private.aal_satisfied() then
    raise exception 'Complete two-factor verification before continuing.' using errcode = '42501';
  end if;
  return v;
end;
$function$;

-- For the storage policies: the same rule, as a yes or no.
create or replace function private.is_brand_admin()
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select (select auth.uid()) is not null and private.has_role('admin') and not private.is_demo_user() and private.aal_satisfied();
$function$;

-- --- saving -----------------------------------------------------------------------------------------------------------
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
  if coalesce(p_heading_font, '') not in ('playfair', 'georgia', 'book', 'sans') then
    raise exception 'Choose a heading font from the list.';
  end if;
  if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'The support email does not look like an email address.';
  end if;
  if v_phone is not null and v_phone !~ '^[0-9 +().-]{7,40}$' then
    raise exception 'The support phone number can only have digits, spaces and + ( ) . -';
  end if;
  -- Lower-case the colours, so '#BB6141' and '#bb6141' are one palette.
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

-- A logo slot: 'logo_light', 'logo_dark', 'mark_light' or 'mark_dark'. p_path is the file in coop-brand
-- ('<slot>/<name>.png|jpg|jpeg|webp', already uploaded), or null to go back to the bundled logo.
-- p_ratio (width / height) is kept for the light lockup.
create or replace function public.admin_set_coop_logo(p_slot text, p_path text, p_ratio numeric default null)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_brand_admin();
  v_path text := nullif(btrim(coalesce(p_path, '')), '');
begin
  if coalesce(p_slot, '') not in ('logo_light', 'logo_dark', 'mark_light', 'mark_dark') then
    raise exception 'Unknown logo slot.';
  end if;
  if v_path is not null then
    if v_path !~ ('^' || p_slot || '/[A-Za-z0-9_-]{1,80}\.(png|jpg|jpeg|webp)$') then
      raise exception 'That is not a logo file for this slot.';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'coop-brand' and o.name = v_path) then
      raise exception 'Upload the file first.';
    end if;
  end if;
  if p_slot = 'logo_light' and v_path is not null and p_ratio is not null and p_ratio not between 1 and 6 then
    raise exception 'A lockup should be between 1 and 6 times as wide as it is tall.';
  end if;

  update public.coop_settings set
    logo_light_path = case when p_slot = 'logo_light' then v_path else logo_light_path end,
    logo_dark_path = case when p_slot = 'logo_dark' then v_path else logo_dark_path end,
    mark_light_path = case when p_slot = 'mark_light' then v_path else mark_light_path end,
    mark_dark_path = case when p_slot = 'mark_dark' then v_path else mark_dark_path end,
    logo_ratio = case when p_slot = 'logo_light' then (case when v_path is null then null else round(p_ratio, 3) end) else logo_ratio end,
    updated_at = now(), updated_by = v_actor
  where id = 'coop';

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_logo_updated', 'coop_settings', 'coop', jsonb_build_object('slot', p_slot, 'path', v_path));
end;
$function$;

-- Back to the Veritas Village look: palette, heading font and logos. The name and the support contact stay.
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
    logo_light_path = null, logo_dark_path = null, mark_light_path = null, mark_dark_path = null, logo_ratio = null,
    updated_at = now(), updated_by = v_actor
  where id = 'coop';
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_appearance_reset', 'coop_settings', 'coop', '{}'::jsonb);
end;
$function$;

revoke all on function private.hex_luminance(text) from public, anon;
revoke all on function private.contrast_ratio(text, text) from public, anon;
revoke all on function private.coop_accent_problems(jsonb) from public, anon;
revoke all on function private.require_brand_admin() from public, anon, authenticated;
revoke all on function private.is_brand_admin() from public, anon;
grant execute on function private.is_brand_admin() to authenticated;
revoke all on function public.admin_save_coop_settings(text, text, jsonb, text, text, text) from public, anon;
revoke all on function public.admin_set_coop_logo(text, text, numeric) from public, anon;
revoke all on function public.admin_reset_coop_appearance() from public, anon;
grant execute on function public.admin_save_coop_settings(text, text, jsonb, text, text, text) to authenticated;
grant execute on function public.admin_set_coop_logo(text, text, numeric) to authenticated;
grant execute on function public.admin_reset_coop_appearance() to authenticated;

-- --- storage: the public bucket for logos -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('coop-brand', 'coop-brand', true, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 1048576, allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

-- Anyone can load a logo by its public URL (no policy is needed for that). Only a brand admin can list, add,
-- replace or remove files, and only in the four slot folders.
create policy coop_brand_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'coop-brand' and private.is_brand_admin());
create policy coop_brand_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'coop-brand' and private.is_brand_admin()
    and name ~ '^(logo_light|logo_dark|mark_light|mark_dark)/[A-Za-z0-9_-]{1,80}\.(png|jpg|jpeg|webp)$');
create policy coop_brand_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'coop-brand' and private.is_brand_admin())
  with check (bucket_id = 'coop-brand' and private.is_brand_admin()
    and name ~ '^(logo_light|logo_dark|mark_light|mark_dark)/[A-Za-z0-9_-]{1,80}\.(png|jpg|jpeg|webp)$');
create policy coop_brand_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'coop-brand' and private.is_brand_admin());
-- Whatever other policies say, nobody else writes to this bucket.
create policy coop_brand_gate_insert on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'coop-brand' or private.is_brand_admin());
create policy coop_brand_gate_update on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'coop-brand' or private.is_brand_admin());
create policy coop_brand_gate_delete on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'coop-brand' or private.is_brand_admin());
