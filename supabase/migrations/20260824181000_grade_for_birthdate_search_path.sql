-- Missed set search_path on this one when it was first written -- caught by
-- get_advisors(type: "security") after adding family_self_enroll. No table
-- access inside the function (pure date arithmetic), so the practical risk
-- was minimal, but every other function in this schema follows this
-- convention and this one should too.
create or replace function private.grade_for_birthdate(p_birthdate date, p_cutoff date)
returns text
language sql immutable
set search_path to ''
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
