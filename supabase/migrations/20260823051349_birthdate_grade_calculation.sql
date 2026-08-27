-- Grade, calculated from a birthdate instead of typed in directly.
--
-- Before this there was no way to edit a child's grade at all -- families-tab
-- only had inputs for name/active -- so the two "7" and "9" values sitting in
-- age_band for Erlina and Riona are literal ages, entered by hand straight
-- into the database early on, with nowhere in the app to correct them.
--
-- Sept 1 is the cutoff: a child's grade for a school year is their age as of
-- September 1 of that year's starting calendar year, the common U.S. district
-- convention. age_band remains the column everything else already reads
-- (classes.grades matching, admin display) -- it is now kept in sync by a
-- trigger rather than typed in, unless age_band_override is set, in which case
-- an admin's manual choice always wins and nothing here touches it again.
alter table public.children
  add column if not exists birthdate date,
  add column if not exists age_band_override boolean not null default false;

create or replace function private.grade_for_birthdate(p_birthdate date, p_cutoff date)
returns text
language sql immutable
as $$
  select case
    when p_birthdate is null or p_cutoff is null then null
    when extract(year from age(p_cutoff, p_birthdate))::int < 4 then null
    else (case least(greatest(extract(year from age(p_cutoff, p_birthdate))::int, 4), 17)
      when 4 then 'Pre-K' when 5 then 'K' when 6 then '1' when 7 then '2' when 8 then '3'
      when 9 then '4' when 10 then '5' when 11 then '6' when 12 then '7' when 13 then '8'
      when 14 then '9' when 15 then '10' when 16 then '11' when 17 then '12'
    end)
  end;
$$;

-- Sept 1 of the calendar year a school year's own starts_on falls in -- not
-- literally starts_on itself, since co-op day-one can land later in the month
-- and grade placement shouldn't move around with it.
create or replace function private.grade_cutoff_for_school_year(p_school_year_id uuid)
returns date
language sql stable security definer set search_path to ''
as $$
  select make_date(extract(year from sy.starts_on)::int, 9, 1)
  from public.school_years sy where sy.id = p_school_year_id;
$$;

-- A birthdate entered (or changed) recalculates immediately against whichever
-- school year is current right now -- an admin fixing Erlina's record today
-- should see today's correct grade, not wait for the next year switch. A pure
-- BEFORE trigger: it sets NEW.age_band directly rather than writing the row
-- and reading it back, so it works the same on insert and update.
create or replace function private.recompute_grade_on_birthdate_change()
returns trigger
language plpgsql security definer set search_path to ''
as $$
declare
  v_cutoff date;
begin
  -- Fires on insert, or whenever birthdate or age_band_override changes (the
  -- trigger's column list below), so switching the override back off recomputes
  -- immediately rather than leaving the last overridden value stuck in place.
  if new.age_band_override or new.birthdate is null then return new; end if;

  select private.grade_cutoff_for_school_year(id) into v_cutoff
    from public.school_years where is_current limit 1;
  if v_cutoff is null then return new; end if;

  new.age_band := private.grade_for_birthdate(new.birthdate, v_cutoff);
  return new;
end;
$$;

drop trigger if exists children_recompute_grade on public.children;
create trigger children_recompute_grade
  before insert or update of birthdate, age_band_override on public.children
  for each row execute function private.recompute_grade_on_birthdate_change();

-- Every non-overridden child moves up together the moment a new year becomes
-- current -- "each year they go up a grade" without anyone touching a roster.
create or replace function private.recompute_grades_for_school_year()
returns trigger
language plpgsql security definer set search_path to ''
as $$
declare
  v_cutoff date;
begin
  if not new.is_current or (tg_op = 'UPDATE' and old.is_current) then return new; end if;
  v_cutoff := private.grade_cutoff_for_school_year(new.id);
  if v_cutoff is null then return new; end if;

  update public.children
    set age_band = private.grade_for_birthdate(birthdate, v_cutoff)
    where birthdate is not null and not age_band_override and active;
  return new;
end;
$$;

drop trigger if exists school_years_recompute_grades on public.school_years;
create trigger school_years_recompute_grades
  after insert or update of is_current on public.school_years
  for each row execute function private.recompute_grades_for_school_year();
