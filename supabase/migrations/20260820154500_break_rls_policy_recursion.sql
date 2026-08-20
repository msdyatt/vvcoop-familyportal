create or replace function private.has_child_family_access(wanted_child_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.children c
    join public.family_members fm on fm.family_id = c.family_id
    where c.id = wanted_child_id and fm.user_id = (select auth.uid())
  ) and private.is_active_user();
$$;

create or replace function private.has_class_family_access(wanted_class_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.enrollments e
    join public.children c on c.id = e.child_id
    join public.family_members fm on fm.family_id = c.family_id
    where e.class_id = wanted_class_id
      and e.status = 'active'
      and fm.user_id = (select auth.uid())
  ) and private.is_active_user();
$$;

create or replace function private.teacher_has_child(wanted_child_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.enrollments e
    join public.teacher_assignments ta on ta.class_id = e.class_id
    where e.child_id = wanted_child_id
      and e.status = 'active'
      and ta.user_id = (select auth.uid())
  ) and private.is_active_user();
$$;

revoke all on function private.has_child_family_access(uuid) from public, anon;
revoke all on function private.has_class_family_access(uuid) from public, anon;
revoke all on function private.teacher_has_child(uuid) from public, anon;
grant execute on function private.has_child_family_access(uuid) to authenticated;
grant execute on function private.has_class_family_access(uuid) to authenticated;
grant execute on function private.teacher_has_child(uuid) to authenticated;

drop policy if exists children_read on public.children;
create policy children_read on public.children for select to authenticated using (
  private.has_role('admin')
  or private.has_child_family_access(id)
  or private.teacher_has_child(id)
);

drop policy if exists enrollments_read on public.enrollments;
create policy enrollments_read on public.enrollments for select to authenticated using (
  private.has_role('admin')
  or private.teaches_class(class_id)
  or private.has_child_family_access(child_id)
);

drop policy if exists teacher_assignments_read on public.teacher_assignments;
create policy teacher_assignments_read on public.teacher_assignments for select to authenticated using (
  user_id = (select auth.uid())
  or private.has_role('admin')
  or private.teaches_class(class_id)
  or private.has_class_family_access(class_id)
);

drop policy if exists assignments_read on public.assignments;
create policy assignments_read on public.assignments for select to authenticated using (
  private.has_role('admin')
  or private.teaches_class(class_id)
  or private.has_class_family_access(class_id)
);

drop policy if exists notes_read on public.teacher_notes;
create policy notes_read on public.teacher_notes for select to authenticated using (
  private.has_role('admin')
  or (visibility <> 'admins' and private.teaches_class(class_id))
  or (visibility = 'family' and private.has_child_family_access(child_id))
);

drop policy if exists posts_read on public.posts;
create policy posts_read on public.posts for select to authenticated using (
  published_at is not null and (
    audience in ('public', 'families')
    or (audience = 'teachers' and (private.has_role('teacher') or private.has_role('admin')))
    or (audience = 'class' and (private.teaches_class(class_id) or private.has_class_family_access(class_id) or private.has_role('admin')))
  )
);

drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated using (
  audience in ('public', 'families')
  or (audience = 'teachers' and (private.has_role('teacher') or private.has_role('admin')))
  or (audience = 'class' and (private.teaches_class(class_id) or private.has_class_family_access(class_id) or private.has_role('admin')))
);

drop policy if exists media_read on public.media;
create policy media_read on public.media for select to authenticated using (
  private.has_role('admin') or (
    private.is_active_user()
    and not exists (select 1 from public.media_consents mc where mc.media_id = media.id and mc.approved = false)
    and (
      audience = 'families'
      or (audience = 'teachers' and private.has_role('teacher'))
      or (audience = 'class' and class_id is not null and (private.teaches_class(class_id) or private.has_class_family_access(class_id)))
    )
  )
);

drop policy if exists media_consents_read on public.media_consents;
create policy media_consents_read on public.media_consents for select to authenticated using (
  private.has_role('admin') or private.has_child_family_access(child_id)
);
