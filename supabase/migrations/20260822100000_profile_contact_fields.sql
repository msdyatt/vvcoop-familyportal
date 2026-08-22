alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists emergency_contact_name text;
alter table public.profiles add column if not exists emergency_contact_phone text;

grant update (phone, emergency_contact_name, emergency_contact_phone) on public.profiles to authenticated;
