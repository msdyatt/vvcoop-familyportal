-- Lets a family mark a class date's prework done, per child.
--
-- events.requires_prework was a static badge -- nothing recorded whether a
-- family actually did the thing, so it stayed "Something to do before class"
-- forever even after they had. Tracked per (event, child) rather than per
-- family, since one household's children can be in different classes with
-- different prework on the same day.
create table if not exists public.event_completions (
  event_id uuid not null references public.events(id) on delete cascade,
  child_id uuid not null references public.children(id) on delete cascade,
  completed_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz not null default now(),
  primary key (event_id, child_id)
);

grant select, insert, update, delete on public.event_completions to authenticated;

alter table public.event_completions enable row level security;

create policy event_completions_family on public.event_completions
  for all to authenticated
  using (private.has_child_family_access(child_id) or private.has_role('admin') or exists (
    select 1 from public.events e where e.id = event_completions.event_id and private.teaches_class(e.class_id)
  ))
  with check (private.has_child_family_access(child_id) or private.has_role('admin'));
