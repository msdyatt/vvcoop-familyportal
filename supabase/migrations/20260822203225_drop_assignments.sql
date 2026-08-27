-- Drop the dormant assignments table
-- ---------------------------------------------------------------------------
-- Homework was folded into class dates: one `events` row now carries the topic,
-- the date, where, instructions and a requires_prework flag, which is what
-- families actually need to read. Nothing has written to `assignments` since,
-- and the last reader -- the "Assignments" list in the child detail panel --
-- moved to class dates in the same change as this migration.
--
-- Checked before dropping: no foreign key in any other table references
-- assignments, it has no triggers, and it held a single test row
-- ("Study Meowmix"). Its two policies and the class/due index go with it.
--
-- Leaving a table nothing reads or writes is how db/schema.ts came to describe
-- a database that did not exist; a dormant table is a trap for whoever reads
-- the schema next expecting it to mean something.
-- ---------------------------------------------------------------------------

drop table if exists public.assignments;
