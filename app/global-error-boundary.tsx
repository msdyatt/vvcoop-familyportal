"use client";

import { Component, ReactNode } from "react";
import { getSupabaseBrowserClient } from "../lib/supabase";

type Props = { children: ReactNode };
type State = { hasError: boolean };

/**
 * Catches crashes in the render tree that ErrorReporter's window listeners
 * can't -- React swallows those before they ever reach `window.onerror`.
 * A class component because React's error-boundary lifecycle has no hook
 * equivalent.
 */
export default class GlobalErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    try {
      // Same two fixes as error-reporter.tsx: .then() so the query builder
      // actually sends the request instead of building one nobody fires, and
      // no location hash (a live invite/recovery #access_token can still be
      // there) going into a table every admin can read.
      const url = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}${window.location.search}` : null;
      getSupabaseBrowserClient()?.rpc("report_client_error", {
        p_message: error.message,
        p_stack: `${error.stack ?? ""}\n${info.componentStack ?? ""}`,
        p_url: url,
        p_user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      }).then(undefined, () => {
        // Swallow -- see error-reporter.tsx for why.
      });
    } catch {
      // Reporting an error must never itself throw.
    }
  }

  render() {
    if (this.state.hasError) {
      return <div className="global-error-fallback">
        <p className="eyebrow">Veritas Village</p>
        <h1>Something went wrong.</h1>
        <p>Please refresh the page. If this keeps happening, let us know at <a href="mailto:veritasvillagecoop@gmail.com">veritasvillagecoop@gmail.com</a>.</p>
        <button type="button" onClick={() => window.location.reload()}>Refresh</button>
      </div>;
    }
    return this.props.children;
  }
}
