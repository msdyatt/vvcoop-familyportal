-- Real account deletion.
--
-- Until now, deleting a person was impossible: fourteen columns point at
-- profiles with no rule for what happens when the person goes, so removing
-- one failed the moment they had written a note, sent a form, or posted news.
-- "Delete my account" only flagged the account as removed.
--
-- What a deleted person leaves behind, by design:
--   * Records that belong to the household or the co-op stay, without a name:
--     teacher notes, news posts, documents, signed-form records, enrollment
--     requests, invitations they sent, audit log entries, library photos.
--   * Things that are only theirs go: print requests, note read-receipts, and
--     (through the function below) their messages, pending photo submissions,
--     profile photo, and every trace of their email address in invitations,
--     the email log and the audit log.

-- --- records that keep going without the person --------------------------------
alter table public.audit_log alter column actor_user_id drop not null;
alter table public.audit_log drop constraint if exists audit_log_actor_user_id_fkey,
  add constraint audit_log_actor_user_id_fkey foreign key (actor_user_id) references public.profiles(id) on delete set null;

alter table public.documents drop constraint if exists documents_uploaded_by_user_id_fkey,
  add constraint documents_uploaded_by_user_id_fkey foreign key (uploaded_by_user_id) references public.profiles(id) on delete set null;

alter table public.enrollment_requests alter column requested_by drop not null;
alter table public.enrollment_requests drop constraint if exists enrollment_requests_requested_by_fkey,
  add constraint enrollment_requests_requested_by_fkey foreign key (requested_by) references public.profiles(id) on delete set null;

alter table public.family_requirements drop constraint if exists family_requirements_signed_by_user_id_fkey,
  add constraint family_requirements_signed_by_user_id_fkey foreign key (signed_by_user_id) references public.profiles(id) on delete set null;
alter table public.family_requirements drop constraint if exists family_requirements_updated_by_fkey,
  add constraint family_requirements_updated_by_fkey foreign key (updated_by) references public.profiles(id) on delete set null;

alter table public.integration_settings drop constraint if exists integration_settings_updated_by_fkey,
  add constraint integration_settings_updated_by_fkey foreign key (updated_by) references public.profiles(id) on delete set null;

alter table public.invitations alter column invited_by_user_id drop not null;
alter table public.invitations drop constraint if exists invitations_invited_by_user_id_fkey,
  add constraint invitations_invited_by_user_id_fkey foreign key (invited_by_user_id) references public.profiles(id) on delete set null;

alter table public.media alter column uploaded_by_user_id drop not null;
alter table public.media drop constraint if exists media_uploaded_by_user_id_fkey,
  add constraint media_uploaded_by_user_id_fkey foreign key (uploaded_by_user_id) references public.profiles(id) on delete set null;
alter table public.media_consents drop constraint if exists media_consents_approved_by_user_id_fkey,
  add constraint media_consents_approved_by_user_id_fkey foreign key (approved_by_user_id) references public.profiles(id) on delete set null;

alter table public.posts alter column author_user_id drop not null;
alter table public.posts drop constraint if exists posts_author_user_id_fkey,
  add constraint posts_author_user_id_fkey foreign key (author_user_id) references public.profiles(id) on delete set null;

alter table public.signature_requests drop constraint if exists signature_requests_requested_by_user_id_fkey,
  add constraint signature_requests_requested_by_user_id_fkey foreign key (requested_by_user_id) references public.profiles(id) on delete set null;

alter table public.teacher_notes alter column author_user_id drop not null;
alter table public.teacher_notes drop constraint if exists teacher_notes_author_user_id_fkey,
  add constraint teacher_notes_author_user_id_fkey foreign key (author_user_id) references public.profiles(id) on delete set null;

-- --- things that are only the person's own go with them ----------------------------
alter table public.print_requests drop constraint if exists print_requests_requested_by_user_id_fkey,
  add constraint print_requests_requested_by_user_id_fkey foreign key (requested_by_user_id) references public.profiles(id) on delete cascade;
alter table public.teacher_note_reads drop constraint if exists teacher_note_reads_user_id_fkey,
  add constraint teacher_note_reads_user_id_fkey foreign key (user_id) references public.profiles(id) on delete cascade;

-- --- erasing a person's data ----------------------------------------------------------
-- Called by the delete-account edge function (service role only). It does the
-- database half in one transaction and returns what the function must do next:
-- the storage files to delete. The sign-in itself is deleted afterwards through
-- the auth API, which cascades the profile and everything that follows it.
create or replace function public.erase_account_data(p_user uuid, p_delete_household boolean default false)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  v_email text;
  v_avatar text;
  v_paths text[] := '{}';
  v_family record;
  v_households_deleted text[] := '{}';
  v_orphaned text[] := '{}';
  v_taught text[];
  v_was_admin boolean;
  v_summary text;
begin
  select email, avatar_path into v_email, v_avatar from public.profiles where id = p_user;
  if v_email is null then raise exception 'That account does not exist.'; end if;

  v_was_admin := exists (select 1 from public.user_roles where user_id = p_user and role = 'admin');
  if v_was_admin and not exists (
    select 1 from public.user_roles r join public.profiles p on p.id = r.user_id and p.status = 'active'
    where r.role = 'admin' and r.user_id <> p_user) then
    raise exception 'last_admin';
  end if;

  -- Files that are only this person's: profile photo, photos they sent in
  -- messages, photos they submitted that are still waiting, print-request files.
  if v_avatar is not null then v_paths := v_paths || v_avatar; end if;
  v_paths := v_paths
    || coalesce((select array_agg(image_path) from public.messages where sender_id = p_user and image_path is not null), '{}')
    || coalesce((select array_agg(p) from (
         select storage_path as p from public.photos where uploaded_by = p_user and status = 'pending'
         union all select thumb_path from public.photos where uploaded_by = p_user and status = 'pending') x), '{}')
    || coalesce((select array_agg(storage_path) from public.print_requests where requested_by_user_id = p_user and storage_path is not null), '{}');

  -- Everything they said is erased; the conversation itself stays for the others.
  update public.messages
  set body = null, image_path = null, deleted_at = coalesce(deleted_at, now()), deleted_by = null
  where sender_id = p_user and (body is not null or image_path is not null);
  delete from public.photos where uploaded_by = p_user and status = 'pending';

  -- Every trace of their email address outside their own account.
  delete from public.invitations where lower(email) = lower(v_email);
  delete from public.email_outbox where lower(recipient_email) = lower(v_email);
  update public.audit_log set detail = detail - 'email' where lower(detail ->> 'email') = lower(v_email);

  -- A household with no one else in it: delete it if asked, otherwise leave it
  -- for an administrator to close out once the co-op's record-keeping is met.
  for v_family in
    select fm.family_id as id, f.display_name
    from public.family_members fm join public.families f on f.id = fm.family_id
    where fm.user_id = p_user
  loop
    if not exists (select 1 from public.family_members where family_id = v_family.id and user_id <> p_user) then
      if p_delete_household then
        v_paths := v_paths
          || coalesce((select array_agg(storage_path) from public.documents where family_id = v_family.id and storage_path is not null), '{}')
          || coalesce((select array_agg(avatar_path) from public.children where family_id = v_family.id and avatar_path is not null), '{}');
        delete from public.families where id = v_family.id;
        v_households_deleted := v_households_deleted || v_family.display_name;
      else
        v_orphaned := v_orphaned || v_family.display_name;
      end if;
    end if;
  end loop;

  select array_agg(c.title order by c.title) into v_taught
  from public.teacher_assignments ta join public.classes c on c.id = ta.class_id where ta.user_id = p_user;

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (p_user, 'account_deleted', 'profile', p_user::text, jsonb_build_object(
    'was_admin', v_was_admin, 'households_deleted', cardinality(v_households_deleted),
    'households_without_adults', cardinality(v_orphaned)));

  v_summary := concat_ws(' ',
    case when cardinality(v_orphaned) > 0 then 'No adults are left in: ' || array_to_string(v_orphaned, ', ') || '. Delete the household when its records are no longer needed.' end,
    case when v_taught is not null then 'They taught: ' || array_to_string(v_taught, ', ') || '.' end);
  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type)
  select r.user_id, 'account_deleted', 'A member deleted their account', coalesce(nullif(v_summary, ''), 'No action is needed.'),
    '/family-village/admin', 'account'
  from public.user_roles r join public.profiles p on p.id = r.user_id and p.status = 'active'
  where r.role = 'admin' and r.user_id <> p_user;

  return jsonb_build_object(
    'email', v_email, 'storage_paths', to_jsonb(v_paths),
    'households_deleted', to_jsonb(v_households_deleted), 'households_without_adults', to_jsonb(v_orphaned));
end;
$function$;

revoke all on function public.erase_account_data(uuid, boolean) from public, anon, authenticated;
grant execute on function public.erase_account_data(uuid, boolean) to service_role;
