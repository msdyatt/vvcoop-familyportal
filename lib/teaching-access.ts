import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Who sees Teaching in the portal.
 *
 * Teaching items (Teaching, Team news, My classes, Print queue) appear for anyone who has the `teacher`
 * role, OR is assigned to a class in the current school year. In this co-op most parents also teach, and a
 * few families buy out of teaching, so being a teacher is a matter of this year's class assignment, not a
 * label on the account: a parent assigned a class this year sees Teaching with no admin step, and a parent
 * who is not assigned one (and has no teacher role) does not.
 *
 * "Assigned" is a teacher_assignments row (lead or assistant) on an active class whose school year is the one
 * flagged current. When the year rolls over, the copied assignments make the new year's teachers appear and
 * last year's drop away.
 *
 * Showing the items is navigation only. What a teacher can read and change is still decided by row-level
 * security in the database, where some things (the teachers' news channel, the print queue) need the role.
 */
export async function teachesThisYear(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("teacher_assignments")
    .select("class_id,classes!inner(active,school_years!inner(is_current))")
    .eq("user_id", userId)
    .eq("classes.active", true)
    .eq("classes.school_years.is_current", true)
    .limit(1);
  return !error && (data?.length ?? 0) > 0;
}
