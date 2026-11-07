-- Account erasure and signing records.
--
-- A sealed signature is a legal record the co-op may need years from now, so
-- erasing a person or a household does not erase it:
--   * the signer rows and the audit trail stay; the person's name stays on them
--     (it is already printed on the sealed certificate) but the email address
--     stored beside it is cleared;
--   * when a household is deleted, its signed documents under sign/ are not
--     deleted from storage, and sign_requests keeps pointing at them.
-- What a person does lose: the sign-in, the profile, and everything else
-- erase_account_data already removes. The privacy policy says this.

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
  -- Signing records are kept (the sealed certificate already carries the name), but
  -- the address stored beside the name is not needed once the account is gone.
  update public.sign_signers set email = null where user_id = p_user;

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
          || coalesce((select array_agg(storage_path) from public.documents
                       where family_id = v_family.id and storage_path is not null and storage_path not like 'sign/%'), '{}')
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
