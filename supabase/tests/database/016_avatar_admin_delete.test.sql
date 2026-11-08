-- Only an administrator may delete profile and child photos from storage, and only those.
-- (Storage deletes go through the Storage API, so this checks the policy itself.)
begin;
select plan(3);

select ok(exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'avatar_admin_delete' and cmd = 'DELETE'), 'there is a delete policy for photos');
select ok((select qual like '%has_role%admin%' from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'avatar_admin_delete'), 'it requires the administrator role');
select ok((select qual like '%avatars/%' from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'avatar_admin_delete'), 'and only covers the avatars folder');

select * from finish();
rollback;
