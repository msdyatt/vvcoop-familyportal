-- Let the front page actually show public news
-- ---------------------------------------------------------------------------
-- The composer has always offered a "public" audience, but posts_read is
-- `to authenticated`, so an unauthenticated visitor could read nothing and the
-- marketing page never rendered any. Choosing "public" published into a void.
--
-- Scoped as tightly as the name implies: published posts whose audience is
-- exactly 'public', and the files attached to them. Nothing else becomes
-- anonymously readable.
-- ---------------------------------------------------------------------------

drop policy if exists posts_public_read on public.posts;
create policy posts_public_read on public.posts
  for select to anon
  using (published_at is not null and audience = 'public'::public.audience);

drop policy if exists post_attachments_public_read on public.post_attachments;
create policy post_attachments_public_read on public.post_attachments
  for select to anon
  using (
    exists (
      select 1 from public.posts p
      where p.id = post_attachments.post_id
        and p.published_at is not null
        and p.audience = 'public'::public.audience
    )
  );

grant select on public.posts, public.post_attachments to anon;
