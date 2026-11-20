/**
 * The installed web app's manifest, with the co-op's name (issue #140; public.coop_settings).
 *
 * Served at /app.webmanifest (app/layout.tsx links it). public/manifest.webmanifest is the template: icons, colours and paths stay as they are there. This route
 * reads the co-op's name from the settings row (readable without signing in) and puts it in the name, the
 * short name and the description. If the settings cannot be read quickly, the template is served unchanged, so
 * installing the app never depends on the database. Icons are not themed: a home-screen icon needs fixed sizes
 * and a maskable version, which a logo upload does not provide.
 */
export const MANIFEST_PATH = "/app.webmanifest";
/** The static template. Static files are served before the Worker runs, so the branded copy needs its own path. */
export const MANIFEST_TEMPLATE_PATH = "/manifest.webmanifest";

const UPSTREAM_TIMEOUT_MS = 2_000;
const TEMPLATE_NAME = "Veritas Village";

type Fetcher = { fetch(request: Request | string, init?: RequestInit): Promise<Response> };

/** The template with the co-op's name in place of the bundled one. Pure, for the tests. */
export function brandManifest(template: Record<string, unknown>, name: string | null): Record<string, unknown> {
  const coop = typeof name === "string" ? name.trim().slice(0, 80) : "";
  if (!coop || coop === TEMPLATE_NAME) return template;
  const swap = (value: unknown) => (typeof value === "string" ? value.replaceAll(TEMPLATE_NAME, coop) : value);
  return { ...template, name: swap(template.name), short_name: coop, description: swap(template.description) };
}

async function coopName(supabase: { url: string; key: string }, fetchImpl: typeof fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${supabase.url.replace(/\/$/, "")}/rest/v1/coop_settings?select=name&id=eq.coop`, {
      headers: { apikey: supabase.key, accept: "application/json" }, signal: controller.signal,
    });
    if (!response.ok) return null;
    const rows = await response.json() as { name?: unknown }[];
    return typeof rows?.[0]?.name === "string" ? rows[0].name : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleManifest(request: Request, assets: Fetcher, supabase: { url: string; key: string }, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const asset = await assets.fetch(new Request(new URL(MANIFEST_TEMPLATE_PATH, request.url)));
  if (!asset.ok) return asset;
  let template: Record<string, unknown>;
  try { template = await asset.clone().json(); } catch { return asset; }
  const body = brandManifest(template, await coopName(supabase, fetchImpl));
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=300" },
  });
}
