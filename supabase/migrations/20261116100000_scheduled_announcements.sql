-- Scheduled announcements: write a news post now, have it go out later.
-- ---------------------------------------------------------------------------
-- A news post had only two states in the app: published the moment it was saved, or (in the
-- schema) a draft with no published_at that nobody could create from the screen. Both of
-- the things that happen when a post goes out already key off published_at:
--
--   * posts_read / posts_public_read / can_read_post hide a post with no published_at from
--     everyone but administrators, and
--   * the #Announcements card (private.post_to_channels) fires when published_at is set.
--
-- So "scheduled" is simply "not published yet, with a time attached":
--
--   scheduled_for        when it should go out (a real instant; the screen shows it in
--                        America/Chicago). Set while published_at is null = scheduled.
--   scheduled_by         the administrator who last set the time. If they are later removed or
--                        stop being an active administrator, the post is HELD, not sent.
--   schedule_held_reason why the publisher did not send it ('scheduler_unavailable').
--
-- What changes at publish time, and only then:
--   * the bell/push notification (private.notify_post_published) used to run on INSERT only,
--     because every post was published at insert. It now also runs when published_at goes from
--     null to a time, which is the only thing a scheduled post does. A post is notified once.
--   * the #Announcements card already ran on that update.
--
-- Publishing is private.publish_due_posts(), run by pg_cron every minute. It locks each due
-- row (FOR UPDATE SKIP LOCKED) and re-checks published_at, so a retry or two overlapping runs
-- publish a post exactly once.
--
-- Audit log: news_scheduled, news_schedule_edited, news_schedule_cancelled, news_published
-- (by an administrator or by the schedule) and news_schedule_held.
-- ---------------------------------------------------------------------------

alter table public.posts
  add column if not exists scheduled_for timestamptz,
  add column if not exists scheduled_by uuid references public.profiles(id) on delete set null,
  add column if not exists schedule_held_reason text check (schedule_held_reason in ('scheduler_unavailable'));

-- A hold only makes sense on a post that is still waiting.
alter table public.posts drop constraint if exists posts_hold_only_while_scheduled;
alter table public.posts add constraint posts_hold_only_while_scheduled
  check (schedule_held_reason is null or (scheduled_for is not null and published_at is null));

create index if not exists posts_due_idx on public.posts (scheduled_for)
  where published_at is null and scheduled_for is not null;

comment on column public.posts.scheduled_for is
  'When this post is due to go out. A post with scheduled_for set and published_at null is scheduled: families, teachers and the public site cannot see it and nothing has been sent. Kept after publishing as a record of what was planned.';

-- --- the rules a schedule must follow, whoever writes the row -----------------------------
-- Past times are refused for any new or changed schedule (the publisher and the hold flag
-- leave scheduled_for alone, so they pass through untouched). A year ahead is the limit, to
-- catch a typo in the year.
create or replace function private.posts_schedule_guard()
returns trigger
language plpgsql set search_path to ''
as $function$
begin
  if new.published_at is not null then
    -- Published: it is no longer waiting, so it can no longer be held.
    new.schedule_held_reason := null;
    return new;
  end if;
  if new.scheduled_for is not null
     and (tg_op = 'INSERT' or old.scheduled_for is distinct from new.scheduled_for) then
    if new.scheduled_for <= now() then
      raise exception 'Choose a time in the future.' using errcode = 'P0001';
    end if;
    if new.scheduled_for > now() + interval '1 year' then
      raise exception 'Choose a time within the next year.' using errcode = 'P0001';
    end if;
  end if;
  if new.scheduled_for is null then new.schedule_held_reason := null; end if;
  return new;
end;
$function$;

drop trigger if exists posts_schedule_guard on public.posts;
create trigger posts_schedule_guard
  before insert or update on public.posts
  for each row execute function private.posts_schedule_guard();

-- --- the notification now fires at publish time, not only at insert ----------------------
-- Same recipients as before (exactly who posts_read lets see the post, minus its author). One
-- fix on the way through: "p.id <> author" is null, not true, when the author's account has
-- been removed (author_user_id is set null on deletion), which would have notified nobody.
create or replace function private.notify_post_published()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  if new.published_at is null then return null; end if;
  if tg_op = 'UPDATE' and old.published_at is not null then return null; end if;  -- first publication only

  if new.audience in ('public', 'families') then
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select p.id, 'post_published', new.title, left(new.body, 200), '/family-village/home', 'post', new.id
    from public.profiles p
    where p.status = 'active' and p.id is distinct from new.author_user_id;

  elsif new.audience = 'teachers' then
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select distinct r.user_id, 'post_published', new.title, left(new.body, 200), '/family-village/teacher', 'post', new.id
    from public.user_roles r
    join public.profiles p on p.id = r.user_id
    where r.role = 'teacher' and p.status = 'active' and p.id is distinct from new.author_user_id;

  elsif new.audience = 'class' and new.class_id is not null then
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select distinct recipient, 'post_published', new.title, left(new.body, 200), '/family-village/home', 'post', new.id
    from (
      select ta.user_id as recipient
      from public.teacher_assignments ta
      where ta.class_id = new.class_id
      union
      select fm.user_id as recipient
      from public.enrollments e
      join public.children c on c.id = e.child_id
      join public.family_members fm on fm.family_id = c.family_id
      where e.class_id = new.class_id
    ) recipients
    join public.profiles p on p.id = recipients.recipient
    where p.status = 'active' and p.id is distinct from new.author_user_id;
  end if;

  return null;
end;
$$;

drop trigger if exists posts_notify_published on public.posts;
create trigger posts_notify_published
  after insert or update of published_at on public.posts
  for each row execute function private.notify_post_published();

-- --- who may schedule ------------------------------------------------------------------------
-- Administrators only, and with two-factor satisfied if they have it, exactly like the
-- other administrator functions. (Teachers cannot write news at all today: posts are
-- administrator-write.)
create or replace function private.require_news_admin()
returns uuid
language plpgsql stable security definer set search_path to ''
as $function$
declare v uuid := (select auth.uid());
begin
  if v is null or not private.has_role('admin') then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if not private.aal_satisfied() then
    raise exception 'Complete two-factor verification before continuing.' using errcode = '42501';
  end if;
  return v;
end;
$function$;

-- Create a scheduled post (p_id null), or change one that has not gone out yet: its words, who
-- it is for, and when. Moving a draft onto the calendar counts as scheduling it.
create or replace function public.admin_save_scheduled_post(
  p_id uuid, p_title text, p_body text, p_audience public.audience, p_class_id uuid, p_when timestamptz)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_news_admin();
  v_old public.posts;
  v_id uuid;
  v_title text := btrim(coalesce(p_title, ''));
begin
  if v_title = '' then raise exception 'Give the post a headline.'; end if;
  if p_audience is null then raise exception 'Choose who the post is for.'; end if;
  if p_when is null then raise exception 'Choose when it should go out.'; end if;
  if p_when <= now() then raise exception 'Choose a time in the future.'; end if;
  if p_when > now() + interval '1 year' then raise exception 'Choose a time within the next year.'; end if;
  if p_audience = 'class' then
    if p_class_id is null or not exists (select 1 from public.classes c where c.id = p_class_id) then
      raise exception 'Choose which class this is for.';
    end if;
  end if;

  if p_id is null then
    insert into public.posts (author_user_id, title, body, audience, class_id, published_at, scheduled_for, scheduled_by)
    values (v_actor, v_title, coalesce(p_body, ''), p_audience, case when p_audience = 'class' then p_class_id end, null, p_when, v_actor)
    returning id into v_id;
    insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
    values (v_actor, 'news_scheduled', 'post', v_id::text,
      jsonb_build_object('title', v_title, 'audience', p_audience, 'class_id', case when p_audience = 'class' then p_class_id end, 'scheduled_for', p_when));
    return v_id;
  end if;

  select * into v_old from public.posts where id = p_id for update;
  if not found then raise exception 'That post no longer exists.'; end if;
  if v_old.published_at is not null then
    raise exception 'That post has already gone out. Edit it from the news list.';
  end if;

  update public.posts set
    title = v_title, body = coalesce(p_body, ''), audience = p_audience,
    class_id = case when p_audience = 'class' then p_class_id end,
    scheduled_for = p_when, scheduled_by = v_actor, schedule_held_reason = null,
    updated_at = now()
  where id = p_id;

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, case when v_old.scheduled_for is null then 'news_scheduled' else 'news_schedule_edited' end, 'post', p_id::text,
    jsonb_build_object('title', v_title, 'audience', p_audience, 'class_id', case when p_audience = 'class' then p_class_id end,
      'previous_scheduled_for', v_old.scheduled_for, 'scheduled_for', p_when,
      'changed', (select coalesce(jsonb_agg(c), '[]'::jsonb) from unnest(array[
          case when v_old.title is distinct from v_title then 'headline' end,
          case when v_old.body is distinct from coalesce(p_body, '') then 'text' end,
          case when v_old.audience is distinct from p_audience or v_old.class_id is distinct from (case when p_audience = 'class' then p_class_id end) then 'audience' end,
          case when v_old.scheduled_for is distinct from p_when then 'time' end]) c where c is not null)));
  return p_id;
end;
$function$;

-- Take a post off the schedule. It is kept as a draft (an administrator can publish or
-- reschedule it, or delete it); nothing is sent.
create or replace function public.admin_cancel_scheduled_post(p_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_news_admin(); v_old public.posts;
begin
  select * into v_old from public.posts where id = p_id for update;
  if not found then raise exception 'That post no longer exists.'; end if;
  if v_old.published_at is not null then raise exception 'That post has already gone out.'; end if;
  if v_old.scheduled_for is null then raise exception 'That post is not scheduled.'; end if;

  update public.posts set scheduled_for = null, schedule_held_reason = null, updated_at = now() where id = p_id;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'news_schedule_cancelled', 'post', p_id::text,
    jsonb_build_object('title', v_old.title, 'scheduled_for', v_old.scheduled_for, 'was_held', v_old.schedule_held_reason is not null));
end;
$function$;

-- Publish a scheduled post or a draft right now (the normal notification and #Announcements
-- card follow, once).
create or replace function public.admin_publish_post_now(p_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_news_admin(); v_old public.posts;
begin
  select * into v_old from public.posts where id = p_id for update;
  if not found then raise exception 'That post no longer exists.'; end if;
  if v_old.published_at is not null then raise exception 'That post has already gone out.'; end if;

  update public.posts set published_at = now(), updated_at = now() where id = p_id;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'news_published', 'post', p_id::text,
    jsonb_build_object('title', v_old.title, 'by', 'administrator', 'scheduled_for', v_old.scheduled_for));
end;
$function$;

-- --- the publisher -----------------------------------------------------------------------------
-- Every minute. A post is due when its time has come and nobody has published it. Each is
-- locked while it is published, so overlapping runs skip each other's rows, and the update
-- re-checks published_at, so a retry after a crash finds nothing left to do.
--
-- If the person who scheduled it is no longer an active administrator (their account was
-- removed or they stepped down), the post is held rather than sent in their name: it stays
-- on the News tab marked "held", the administrators are told in the bell, and any
-- administrator can publish, reschedule or cancel it.
--
-- One post that fails to publish does not stop the others; it is tried again next minute.
create or replace function private.publish_due_posts(p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  r record;
  v_published integer := 0; v_held integer := 0; v_failed integer := 0;
  v_ok boolean;
begin
  for r in
    select p.id, p.title, p.scheduled_by, p.scheduled_for
    from public.posts p
    where p.published_at is null and p.scheduled_for is not null and p.scheduled_for <= p_now
      and p.schedule_held_reason is null
    order by p.scheduled_for, p.created_at
    limit 50
    for update of p skip locked
  loop
    begin
      v_ok := r.scheduled_by is not null and exists (
        select 1 from public.profiles pr
        join public.user_roles ur on ur.user_id = pr.id and ur.role = 'admin'
        where pr.id = r.scheduled_by and pr.status = 'active');

      if v_ok then
        update public.posts set published_at = p_now, updated_at = p_now
        where id = r.id and published_at is null;
        insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
        values (r.scheduled_by, 'news_published', 'post', r.id::text,
          jsonb_build_object('title', r.title, 'by', 'schedule', 'scheduled_for', r.scheduled_for));
        v_published := v_published + 1;
      else
        update public.posts set schedule_held_reason = 'scheduler_unavailable' where id = r.id and published_at is null;
        if r.scheduled_by is not null then
          insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
          values (r.scheduled_by, 'news_schedule_held', 'post', r.id::text,
            jsonb_build_object('title', r.title, 'scheduled_for', r.scheduled_for, 'reason', 'scheduler_unavailable'));
        end if;
        insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
        select ur.user_id, 'post_held', 'A scheduled announcement did not go out',
          '"' || left(r.title, 120) || '" was due, but the person who scheduled it is no longer an active administrator. Open News to publish it, change the time or cancel it.',
          '/family-village/admin', 'post', r.id
        from public.user_roles ur
        join public.profiles pr on pr.id = ur.user_id
        where ur.role = 'admin' and pr.status = 'active' and not pr.is_demo;
        v_held := v_held + 1;
      end if;
    exception when others then
      -- The sub-transaction is rolled back: nothing half-published. Tried again next minute.
      raise warning 'publish_due_posts: post % failed: %', r.id, sqlerrm;
      v_failed := v_failed + 1;
    end;
  end loop;
  return jsonb_build_object('published', v_published, 'held', v_held, 'failed', v_failed);
end;
$function$;

-- --- access ------------------------------------------------------------------------------------
revoke all on function private.posts_schedule_guard() from public, anon, authenticated;
revoke all on function private.require_news_admin() from public, anon, authenticated;
revoke all on function private.publish_due_posts(timestamptz) from public, anon, authenticated;
revoke all on function private.notify_post_published() from public, anon, authenticated;

revoke all on function public.admin_save_scheduled_post(uuid, text, text, public.audience, uuid, timestamptz) from public, anon;
revoke all on function public.admin_cancel_scheduled_post(uuid) from public, anon;
revoke all on function public.admin_publish_post_now(uuid) from public, anon;
grant execute on function public.admin_save_scheduled_post(uuid, text, text, public.audience, uuid, timestamptz) to authenticated;
grant execute on function public.admin_cancel_scheduled_post(uuid) to authenticated;
grant execute on function public.admin_publish_post_now(uuid) to authenticated;

-- --- schedule ----------------------------------------------------------------------------------
create extension if not exists pg_cron;

select cron.unschedule('publish-scheduled-posts')
where exists (select 1 from cron.job where jobname = 'publish-scheduled-posts');

select cron.schedule('publish-scheduled-posts', '* * * * *', $$ select private.publish_due_posts(); $$);
