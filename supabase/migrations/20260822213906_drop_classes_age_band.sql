do $$
declare unmigrated int;
begin
  select count(*) into unmigrated
  from public.classes
  where age_band is not null and age_band <> '' and cardinality(grades) = 0;
  if unmigrated > 0 then
    raise exception 'Refusing to drop: % class(es) still have an age_band that was not copied into grades', unmigrated;
  end if;
end $$;

alter table public.classes drop column if exists age_band;
