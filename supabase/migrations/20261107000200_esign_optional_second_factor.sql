-- Two changes to e-signing, both decided after the first version was reviewed.
--
-- 1. A second factor is no longer required to sign. Signing still needs an
--    active profile, an accepted invitation, and a name. A person who already
--    has a second factor set up is still asked for it by the rest of the portal
--    (the aal2_required policy on every table), so having one never gets
--    skipped; the signing rules just do not force anyone to enrol first.
--
-- 2. A document can have two signers, but a household with one adult can still
--    be sent it: that adult signs slot 1 and slot 2's fields are left off the
--    sealed copy. Before, such a household was skipped.

create or replace function private.signing_blockers(p_user uuid)
returns text[]
language plpgsql stable security definer set search_path to ''
as $function$
declare
  v_blockers text[] := '{}';
  v_profile record;
  v_confirmed timestamptz;
begin
  select p.status, p.display_name, p.email into v_profile from public.profiles p where p.id = p_user;
  if not found or v_profile.status <> 'active' then return array['account_not_active']; end if;

  select u.email_confirmed_at into v_confirmed from auth.users u
  where u.id = p_user and (u.banned_until is null or u.banned_until < now());
  if not found then return array['account_not_active']; end if;

  -- Accepting an invitation is what confirms the email address
  -- (see 20261105144838_invitation_accepted_tracking.sql).
  if v_confirmed is null
     or (exists (select 1 from public.invitations i where lower(i.email) = lower(v_profile.email) and i.accepted_at is null)
         and not exists (select 1 from public.invitations i where lower(i.email) = lower(v_profile.email) and i.accepted_at is not null)) then
    v_blockers := array_append(v_blockers, 'invitation_not_accepted'::text);
  end if;

  if btrim(coalesce(v_profile.display_name, '')) = '' then
    v_blockers := array_append(v_blockers, 'profile_incomplete'::text);
  end if;

  return v_blockers;
end;
$function$;

create or replace function public.sign_send(
  p_template uuid,
  p_family_ids uuid[] default null,
  p_requirement uuid default null,
  p_sequential boolean default false,
  p_message text default null,
  p_due_on date default null,
  p_assignments jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_t public.sign_templates;
  v_req public.requirements;
  v_family uuid;
  v_targets uuid[];
  v_users uuid[];
  v_user uuid;
  v_request uuid;
  v_fr uuid;
  v_fr_status text;
  v_slot int;
  v_sent jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
begin
  perform private.sign_require_admin();
  select * into v_t from public.sign_templates where id = p_template for update;
  if not found then raise exception 'That document does not exist.' using errcode = 'P0001'; end if;
  if v_t.status <> 'ready' then
    raise exception 'Place a signature field for each signer before sending.' using errcode = 'P0001';
  end if;
  if v_message is not null and char_length(v_message) > 1000 then
    raise exception 'The note can be up to 1000 characters.' using errcode = 'P0001';
  end if;

  if p_requirement is not null then
    select * into v_req from public.requirements where id = p_requirement;
    if not found or v_req.kind <> 'document' then
      raise exception 'Pick a required document.' using errcode = 'P0001';
    end if;
    if v_req.sign_template_id is not null and v_req.sign_template_id <> p_template then
      raise exception 'That requirement already uses a different document.' using errcode = 'P0001';
    end if;
    update public.requirements set sign_template_id = p_template where id = p_requirement and sign_template_id is null;
  end if;

  if p_family_ids is not null then
    v_targets := p_family_ids;
  elsif p_requirement is not null then
    select coalesce(array_agg(family_id), '{}') into v_targets
    from public.family_requirements where requirement_id = p_requirement and status in ('outstanding', 'sent');
  else
    raise exception 'Choose households, or a requirement to send to.' using errcode = 'P0001';
  end if;

  foreach v_family in array v_targets loop
    if not exists (select 1 from public.families where id = v_family) then
      v_skipped := v_skipped || jsonb_build_object('family_id', v_family, 'reason', 'unknown_household');
      continue;
    end if;
    if exists (select 1 from public.sign_requests where template_id = p_template and family_id = v_family and status <> 'voided') then
      v_skipped := v_skipped || jsonb_build_object('family_id', v_family, 'reason', 'already_sent');
      continue;
    end if;

    if p_assignments ? v_family::text then
      select array_agg(u::uuid order by o) into v_users
      from jsonb_array_elements_text(p_assignments -> v_family::text) with ordinality as e(u, o);
    else
      select array_agg(user_id order by created_at, user_id) into v_users from (
        select fm.user_id, fm.created_at
        from public.family_members fm join public.profiles p on p.id = fm.user_id and p.status = 'active'
        where fm.family_id = v_family
        order by fm.created_at, fm.user_id limit v_t.signers_required) x;
    end if;
    -- A household with fewer adults than the document has signers still gets it:
    -- the adults it has sign their own slots, in order, and fields for a slot
    -- nobody fills are left off the sealed copy. Only a household with no adult
    -- at all is skipped.
    if coalesce(cardinality(v_users), 0) = 0 then
      v_skipped := v_skipped || jsonb_build_object('family_id', v_family, 'reason', 'no_adult');
      continue;
    end if;
    if cardinality(v_users) > v_t.signers_required then
      raise exception 'This document has % signer slots, but % people were chosen.', v_t.signers_required, cardinality(v_users) using errcode = 'P0001';
    end if;
    if exists (
      select 1 from unnest(v_users) u
      where not exists (select 1 from public.family_members fm join public.profiles p on p.id = fm.user_id and p.status = 'active'
                        where fm.family_id = v_family and fm.user_id = u)) then
      raise exception 'Every signer must be an active adult in that household.' using errcode = 'P0001';
    end if;
    if cardinality(v_users) = 2 and v_users[1] = v_users[2] then
      raise exception 'Choose two different people.' using errcode = 'P0001';
    end if;

    v_fr := null;
    if p_requirement is not null then
      select id, status into v_fr, v_fr_status from public.family_requirements
      where requirement_id = p_requirement and family_id = v_family;
      if v_fr_status = 'complete' or v_fr_status = 'waived' then
        v_skipped := v_skipped || jsonb_build_object('family_id', v_family, 'reason', 'already_' || v_fr_status);
        continue;
      end if;
      if v_fr is null then
        insert into public.family_requirements (requirement_id, family_id, status, updated_by)
        values (p_requirement, v_family, 'sent', v_me) returning id into v_fr;
      else
        update public.family_requirements set status = 'sent', updated_by = v_me where id = v_fr;
      end if;
    end if;

    insert into public.sign_requests (template_id, family_id, requirement_id, family_requirement_id, title,
      original_path, original_sha256, page_count, signing_order, message, due_on, created_by)
    values (p_template, v_family, p_requirement, v_fr, v_t.title, v_t.storage_path, v_t.sha256, v_t.page_count,
      case when p_sequential then 'sequential' else 'any' end, v_message, p_due_on, v_me)
    returning id into v_request;

    v_slot := 0;
    foreach v_user in array v_users loop
      v_slot := v_slot + 1;
      insert into public.sign_signers (request_id, slot, user_id, display_name, email)
      select v_request, v_slot, p.id, coalesce(nullif(btrim(p.display_name), ''), split_part(p.email, '@', 1)), p.email
      from public.profiles p where p.id = v_user;
    end loop;

    perform private.sign_log(v_request, null, 'created', jsonb_build_object('title', v_t.title, 'template_id', p_template, 'original_sha256', v_t.sha256));
    perform private.sign_log(v_request, null, 'sent', jsonb_build_object('signers', v_users, 'signing_order', case when p_sequential then 'sequential' else 'any' end));

    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select s.user_id, 'sign_request', 'Please sign: ' || v_t.title,
      coalesce(v_message, 'Veritas Village is asking you to sign this document.'),
      '/family-village/paperwork', 'sign_request', v_request
    from public.sign_signers s where s.request_id = v_request and s.user_id is not null;
    insert into public.email_outbox (recipient_email, subject, html_body, kind, subject_type, subject_id)
    select s.email, 'Please sign: ' || v_t.title,
      '<p>Veritas Village is asking you to sign <strong>' || private.escape_html(v_t.title) || '</strong>.</p>'
        || coalesce('<p>' || private.escape_html(v_message) || '</p>', '')
        || '<p>Sign in to Family Village and open Paperwork to read and sign it: <a href="https://family.veritasvillage.org/family-village/paperwork">family.veritasvillage.org</a></p>',
      'sign_request', 'sign_request', v_request
    from public.sign_signers s where s.request_id = v_request and s.email is not null and s.email <> '';

    insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
    values (v_me, 'sign_request_sent', 'sign_request', v_request::text, jsonb_build_object('title', v_t.title, 'family_id', v_family));

    v_sent := v_sent || jsonb_build_object('request_id', v_request, 'family_id', v_family);
  end loop;

  return jsonb_build_object('sent', v_sent, 'skipped', v_skipped);
end;
$function$;

revoke all on function private.signing_blockers(uuid) from public, anon, authenticated;
revoke all on function public.sign_send(uuid, uuid[], uuid, boolean, text, date, jsonb) from public, anon, authenticated;
grant execute on function public.sign_send(uuid, uuid[], uuid, boolean, text, date, jsonb) to authenticated;
