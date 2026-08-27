-- Files attached to a news post
-- ---------------------------------------------------------------------------
-- A post could carry exactly one image, in posts.image_storage_path. Teachers
-- and families need to open a post and find whatever was attached to it --
-- several photos from a field trip, a supply list PDF -- so attachments become
-- rows rather than a column.
--
-- The existing single image is backfilled here so there is one code path from
-- the start. posts.image_storage_path, attachment_url and video_url are dropped
-- in a follow-up migration once the application has stopped reading them.
-- ---------------------------------------------------------------------------

create table if not exists public.post_attachments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  storage_path text not null,
  file_name text,
  content_type text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists post_attachments_post_idx
  on public.post_attachments(post_id, sort_order);

-- Mirrors posts_read exactly.
--
-- SECURITY DEFINER on purpose: a policy that selects from public.posts would
-- have posts' own RLS applied inside it, which is how this database ended up
-- needing a break_rls_policy_recursion migration once already. Encapsulating
-- the check keeps the two definitions in step without the recursion.
create or replace function private.can_read_post(wanted_post_id uuid)
returns boolean
language sql
stable security definer
set search_path to ''
as $function$
  select exists (
    select 1 from public.posts p
    where p.id = wanted_post_id
      and p.published_at is not null
      and (
        p.audience = any (array['public'::public.audience, 'families'::public.audience])
        or (p.audience = 'teachers'::public.audience
            and (private.has_role('teacher') or private.has_role('admin')))
        or (p.audience = 'class'::public.audience
            and (private.teaches_class(p.class_id)
                 or private.has_class_family_access(p.class_id)
                 or private.has_role('admin')))
      )
  );
$function$;

alter table public.post_attachments enable row level security;

drop policy if exists post_attachments_read on public.post_attachments;
create policy post_attachments_read on public.post_attachments
  for select to authenticated
  using (private.can_read_post(post_id));

-- Publishing is an administrator's job, as it is for posts themselves.
drop policy if exists post_attachments_admin_write on public.post_attachments;
create policy post_attachments_admin_write on public.post_attachments
  for all to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));

grant select on public.post_attachments to authenticated;
grant insert, update, delete on public.post_attachments to authenticated;

-- Carry the existing single image across so nothing is lost when the column goes.
insert into public.post_attachments (post_id, storage_path, file_name, content_type, sort_order)
select p.id, p.image_storage_path, 'photo', 'image/*', 0
from public.posts p
where p.image_storage_path is not null
  and not exists (
    select 1 from public.post_attachments a
    where a.post_id = p.id and a.storage_path = p.image_storage_path
  );
