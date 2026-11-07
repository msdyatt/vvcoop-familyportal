-- Marking a document required, from the Documents screen.
--
-- Until now a "required document" was created in Compliance and a PDF was then
-- attached to it from Documents, two places for one idea. This lets an
-- administrator say, on the document itself, "families must sign this for the
-- current school year". It creates that year's requirement (or adopts an
-- existing document requirement with the same title that has no document yet),
-- so it appears in Compliance and in every family's Paperwork with no second
-- step. Turning it off hides the requirement but keeps every household's record.
create or replace function public.sign_set_required(p_template uuid, p_required boolean, p_due_on date default null)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_t public.sign_templates;
  v_year uuid;
  v_req uuid;
  v_order integer;
begin
  perform private.sign_require_admin();
  select * into v_t from public.sign_templates where id = p_template;
  if not found then raise exception 'That document does not exist.' using errcode = 'P0001'; end if;
  select id into v_year from public.school_years where is_current limit 1;
  if v_year is null then raise exception 'Set a current school year first (under Classes).' using errcode = 'P0001'; end if;

  select id into v_req from public.requirements where school_year_id = v_year and sign_template_id = p_template limit 1;

  if not p_required then
    if v_req is not null then
      update public.requirements set active = false where id = v_req;
      insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
      values ((select auth.uid()), 'requirement_unrequired', 'requirement', v_req::text, jsonb_build_object('title', v_t.title));
    end if;
    return v_req;
  end if;

  if v_req is not null then
    update public.requirements set active = true, due_on = p_due_on where id = v_req;
  else
    -- A document requirement made earlier in Compliance, with the same title and no document yet.
    select id into v_req from public.requirements
    where school_year_id = v_year and kind = 'document' and sign_template_id is null
      and lower(btrim(title)) = lower(btrim(v_t.title))
    limit 1;
    if v_req is not null then
      update public.requirements set sign_template_id = p_template, active = true, due_on = coalesce(p_due_on, due_on) where id = v_req;
    else
      select coalesce(max(sort_order), 0) + 1 into v_order from public.requirements where school_year_id = v_year;
      insert into public.requirements (school_year_id, kind, title, active, sort_order, due_on, sign_template_id)
      values (v_year, 'document', v_t.title, true, v_order, p_due_on, p_template)
      returning id into v_req;
    end if;
    insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
    values ((select auth.uid()), 'requirement_required', 'requirement', v_req::text, jsonb_build_object('title', v_t.title));
  end if;
  return v_req;
end;
$function$;

revoke all on function public.sign_set_required(uuid, boolean, date) from public, anon, authenticated;
grant execute on function public.sign_set_required(uuid, boolean, date) to authenticated;
