-- Each person's choice of bottom-bar destinations, per section of the app.
-- Kept in its own small table (not on profiles) so saving it never touches the
-- profile self-update guard, and so it goes away with the account.

create table public.user_nav_prefs (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint user_nav_prefs_small check (pg_column_size(prefs) < 4000 and jsonb_typeof(prefs) = 'object')
);

alter table public.user_nav_prefs enable row level security;

create policy nav_prefs_select_own on public.user_nav_prefs for select to authenticated
  using (user_id = (select auth.uid()));
create policy nav_prefs_insert_own on public.user_nav_prefs for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy nav_prefs_update_own on public.user_nav_prefs for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy nav_prefs_delete_own on public.user_nav_prefs for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.user_nav_prefs from anon, authenticated;
grant select, insert, update, delete on public.user_nav_prefs to authenticated;
