/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { guardRequest } from "./site-password";
import { httpsRedirect, withSecurityHeaders } from "./security-headers";

// Minimal shape of the Workers runtime's Fetcher binding -- just enough to
// type-check this file's own use of it (ASSETS.fetch(...)), same call as
// pulling in the full @cloudflare/workers-types package just for this.
interface Fetcher {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

interface Env {
  ASSETS: Fetcher;
  SITE_PASSWORD?: string;
  SITE_AUTH_SECRET?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // HTTPS enforcement first, ahead of even the password gate -- there is no
    // reason any route (including the gate's own login form and its Secure
    // cookie) should ever be reachable over plain HTTP.
    const redirect = httpsRedirect(request);
    if (redirect) return redirect;

    const url = new URL(request.url);

    // Shared-password gate, ahead of everything else so no route can slip past
    // it. See worker/site-password.ts -- it stays on until this call is removed
    // on purpose.
    const gated = await guardRequest(request, env);
    if (gated) return withSecurityHeaders(gated);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const imageResponse = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withSecurityHeaders(imageResponse);
    }

    return withSecurityHeaders(await handler.fetch(request, env, ctx));
  },
};

export default worker;
