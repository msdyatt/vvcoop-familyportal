/**
 * The first-run tour. Bump TOUR_VERSION when the tour gains something worth
 * showing everyone once more (a new feature); each person's progress is kept on
 * their profile, so it follows them across devices.
 */
export const TOUR_VERSION = 1;

export type TourStepId = "welcome" | "household" | "messages" | "photos" | "notifications" | "secure" | "teacher" | "admin" | "done";

export type TourContext = {
  roles: string[];
  /** An account that has been around a while sees "what's new" instead of "welcome". */
  returning: boolean;
};

export function tourSteps({ roles, returning }: TourContext): TourStepId[] {
  const steps: TourStepId[] = returning ? [] : ["welcome", "household"];
  steps.push("messages", "photos", "notifications");
  if (!returning) steps.push("secure");
  if (roles.includes("teacher")) steps.push("teacher");
  if (roles.includes("admin")) steps.push("admin");
  steps.push("done");
  return steps;
}

/** A profile older than this is treated as an existing member. */
export const RETURNING_AFTER_DAYS = 7;

export function isReturning(createdAt: string | null | undefined, now = Date.now()): boolean {
  if (!createdAt) return false;
  return now - new Date(createdAt).getTime() > RETURNING_AFTER_DAYS * 86_400_000;
}
