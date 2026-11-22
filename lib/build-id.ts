/**
 * The name of the build this code came from (vite.config.ts sets it: the commit in CI, a timestamp locally). The
 * Worker answers GET /app-version with its own, so a portal tab left open across a deploy can tell it is out of date
 * (app/family-village/portal-frame.tsx). "unknown" outside a Vite build (the node tests).
 */
declare const __VV_BUILD_ID__: string | undefined;

export const BUILD_ID: string = typeof __VV_BUILD_ID__ === "string" ? __VV_BUILD_ID__ : "unknown";

export const APP_VERSION_PATH = "/app-version";

/** Whether the Worker's answer shows a newer build than the one running in this tab. Unsure means no. */
export function isOutOfDate(answer: unknown, running: string = BUILD_ID): boolean {
  if (running === "unknown" || !answer || typeof answer !== "object") return false;
  const build = (answer as { build?: unknown }).build;
  return typeof build === "string" && build !== "" && build !== "unknown" && build !== running;
}
