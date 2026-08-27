"use client";

import { useEffect } from "react";
import { getSupabaseBrowserClient } from "../lib/supabase";

function report(message: string, stack?: string | null) {
  try {
    // A PostgREST query builder only actually sends its request once
    // something calls .then() on it -- an un-awaited, un-chained call here
    // built the request and never fired it, so every client error this was
    // meant to catch was silently going nowhere.
    //
    // window.location.href is deliberately not sent whole: an invite/recovery
    // link lands here with a still-live #access_token in the hash before
    // Supabase's client strips it, and that hash is never sent to a server by
    // the browser on its own -- reading it out here and mailing it to
    // error_log would be the one thing that actually leaks it, to every
    // admin who can read that table.
    const url = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    getSupabaseBrowserClient()?.rpc("report_client_error", {
      p_message: message,
      p_stack: stack ?? null,
      p_url: url,
      p_user_agent: navigator.userAgent,
    }).then(undefined, () => {
      // Swallow -- reporting an error must never itself throw or reject
      // loudly, or a broken reporting pipeline reports itself in a loop.
    });
  } catch {
    // Reporting an error must never itself throw -- that would risk a loop.
  }
}

/**
 * Catches errors React's own boundary can't: anything outside the render
 * tree (a rejected promise, a stray throw in an event handler or timer).
 * Mounted once at the root, next to GlobalErrorBoundary.
 */
export default function ErrorReporter() {
  useEffect(() => {
    function onError(event: ErrorEvent) {
      report(event.message, event.error?.stack);
    }
    function onRejection(event: PromiseRejectionEvent) {
      const reason = event.reason;
      report(String(reason?.message ?? reason), reason?.stack);
    }
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
