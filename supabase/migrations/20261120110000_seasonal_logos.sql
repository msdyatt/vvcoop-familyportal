-- Seasonal logos (issue #140 part 3, issue #110): plumbing only, no artwork.
--
-- An admin uploads variants of the logo (lockup and compact mark, for light and dark grounds; any of the four) with a
-- date range, optionally every year, and an override: 'auto' (show between the dates), 'on' (show now, whatever the
-- date) or 'off' (never). The page picks the variant in force (lib/coop-theme.ts activeVariant) and shows it in place
-- of the co-op's logo; a slot a variant leaves empty shows the co-op's own logo, and that is also what shows when no
-- variant is in force. Read by everyone, like the settings. Written only through the admin functions below.
-- Files go in the coop-brand bucket under seasonal/.

create table public.coop_logo_variants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  starts_on date not null,
  ends_on date not null,
  -- Every year on the same days (the year in the dates is ignored, and the range may run over New Year).
  yearly boolean not null default false,
  override text not null default 'auto' check (override in ('auto', 'on', 'off')),
  logo_light_path text check (logo_light_path ~ '^seasonal/[A-Za-z0-9_-]{1,80}\.(png|jpg|jpeg|webp)$'),
  logo_dark_path text check (logo_dark_path ~ '^seasonal/[A-Za-z0-9_-]{1,80}\.(png|jpg|jpeg|webp)$'),
  mark_light_path text check (mark_light_path ~ '^seasonal/[A-Za-z0-9_-]{1,80}\.(png|jpg|jpeg|webp)$'),
  mark_dark_path text check (mark_dark_path ~ '^seasonal/[A-Za-z0-9_-]{1,80}\.(png|jpg|jpeg|webp)$'),
  logo_ratio numeric check (logo_ratio is null or logo_ratio between 1 and 6),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  constraint coop_logo_variants_has_a_file check (coalesce(logo_light_path, logo_dark_path, mark_light_path, mark_dark_path) is not null),
  constraint coop_logo_variants_dates check (yearly or ends_on >= starts_on)
);

alter table public.coop_logo_variants enable row level security;
create policy coop_logo_variants_read on public.coop_logo_variants for select to anon, authenticated using (true);
revoke all on public.coop_logo_variants from public, anon, authenticated;
grant select on public.coop_logo_variants to anon, authenticated, service_role;

-- Saves a new variant (p_id null) or changes one. Returns its id.
create or replace function public.admin_save_logo_variant(
  p_id uuid, p_name text, p_starts_on date, p_ends_on date, p_yearly boolean, p_override text,
  p_logo_light_path text, p_logo_dark_path text, p_mark_light_path text, p_mark_dark_path text, p_logo_ratio numeric default null)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_brand_admin();
  v_name text := btrim(coalesce(p_name, ''));
  v_paths text[] := array[nullif(btrim(coalesce(p_logo_light_path, '')), ''), nullif(btrim(coalesce(p_logo_dark_path, '')), ''),
                          nullif(btrim(coalesce(p_mark_light_path, '')), ''), nullif(btrim(coalesce(p_mark_dark_path, '')), '')];
  v_path text;
  v_id uuid;
begin
  if char_length(v_name) not between 1 and 60 then raise exception 'Give the seasonal logo a name of up to 60 characters.'; end if;
  if p_starts_on is null or p_ends_on is null then raise exception 'Choose when it starts and ends.'; end if;
  if not coalesce(p_yearly, false) and p_ends_on < p_starts_on then raise exception 'It has to end on or after the day it starts.'; end if;
  if coalesce(p_override, '') not in ('auto', 'on', 'off') then raise exception 'Choose when it shows.'; end if;
  if v_paths[1] is null and v_paths[2] is null and v_paths[3] is null and v_paths[4] is null then
    raise exception 'Upload at least one logo for it.';
  end if;
  foreach v_path in array v_paths loop
    continue when v_path is null;
    if v_path !~ '^seasonal/[A-Za-z0-9_-]{1,80}\.(png|jpg|jpeg|webp)$' then raise exception 'That is not a seasonal logo file.'; end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'coop-brand' and o.name = v_path) then
      raise exception 'Upload the file first.';
    end if;
  end loop;
  if p_logo_ratio is not null and p_logo_ratio not between 1 and 6 then
    raise exception 'A lockup should be between 1 and 6 times as wide as it is tall.';
  end if;

  if p_id is null then
    if (select count(*) from public.coop_logo_variants) >= 24 then raise exception 'There can be at most 24 seasonal logos. Remove an old one first.'; end if;
    insert into public.coop_logo_variants (name, starts_on, ends_on, yearly, override, logo_light_path, logo_dark_path, mark_light_path, mark_dark_path, logo_ratio, updated_by)
    values (v_name, p_starts_on, p_ends_on, coalesce(p_yearly, false), p_override, v_paths[1], v_paths[2], v_paths[3], v_paths[4],
            case when v_paths[1] is null then null else round(p_logo_ratio, 3) end, v_actor)
    returning id into v_id;
  else
    update public.coop_logo_variants set
      name = v_name, starts_on = p_starts_on, ends_on = p_ends_on, yearly = coalesce(p_yearly, false), override = p_override,
      logo_light_path = v_paths[1], logo_dark_path = v_paths[2], mark_light_path = v_paths[3], mark_dark_path = v_paths[4],
      logo_ratio = case when v_paths[1] is null then null else round(p_logo_ratio, 3) end,
      updated_at = now(), updated_by = v_actor
    where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'That seasonal logo no longer exists.'; end if;
  end if;

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_logo_variant_saved', 'coop_logo_variant', v_id::text,
    jsonb_build_object('name', v_name, 'starts_on', p_starts_on, 'ends_on', p_ends_on, 'yearly', coalesce(p_yearly, false), 'override', p_override));
  return v_id;
end;
$function$;

-- Removes a variant. Returns the paths of its files, for the screen to remove from storage.
create or replace function public.admin_delete_logo_variant(p_id uuid)
returns text[]
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_brand_admin();
  v_row public.coop_logo_variants;
begin
  delete from public.coop_logo_variants where id = p_id returning * into v_row;
  if v_row.id is null then raise exception 'That seasonal logo no longer exists.'; end if;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_logo_variant_deleted', 'coop_logo_variant', v_row.id::text, jsonb_build_object('name', v_row.name));
  return array_remove(array[v_row.logo_light_path, v_row.logo_dark_path, v_row.mark_light_path, v_row.mark_dark_path], null);
end;
$function$;

revoke all on function public.admin_save_logo_variant(uuid, text, date, date, boolean, text, text, text, text, text, numeric) from public, anon;
revoke all on function public.admin_delete_logo_variant(uuid) from public, anon;
grant execute on function public.admin_save_logo_variant(uuid, text, date, date, boolean, text, text, text, text, text, numeric) to authenticated;
grant execute on function public.admin_delete_logo_variant(uuid) to authenticated;

-- The bucket's upload rules gain the seasonal/ folder.
drop policy if exists coop_brand_admin_insert on storage.objects;
drop policy if exists coop_brand_admin_update on storage.objects;
create policy coop_brand_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'coop-brand' and private.is_brand_admin()
    and name ~ '^(logo_light|logo_dark|mark_light|mark_dark|seasonal)/[A-Za-z0-9_-]{1,80}\.(png|jpg|jpeg|webp)$');
create policy coop_brand_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'coop-brand' and private.is_brand_admin())
  with check (bucket_id = 'coop-brand' and private.is_brand_admin()
    and name ~ '^(logo_light|logo_dark|mark_light|mark_dark|seasonal)/[A-Za-z0-9_-]{1,80}\.(png|jpg|jpeg|webp)$');
