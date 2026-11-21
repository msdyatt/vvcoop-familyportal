/**
 * Which co-op-wide event audiences a person's own calendar feed carries.
 *
 * Kept apart from calendar-feed/index.ts (which runs with the service-role key and so has no
 * row-level security to lean on) so the rule can be tested on its own. Admin-only events
 * (compliance deadlines and the like) go only into an active administrator's own feed, never a
 * reviewer (demo) account's, and never into the public or class feeds, which do not use this.
 */
export type FeedPerson = { roles: Set<string>; isDemo: boolean; active: boolean };

export function personalFeedAudiences(person: FeedPerson): string[] {
  const audiences = ["public", "families"];
  if (person.roles.has("teacher") || person.roles.has("admin")) audiences.push("teachers");
  if (person.roles.has("admin") && person.active && !person.isDemo) audiences.push("admins");
  return audiences;
}
