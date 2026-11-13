/**
 * Hands the signed-in session to the iPhone app's native screens (Messages is written in Swift and talks to
 * Supabase itself, as the person, so row-level security applies exactly as it does here).
 *
 * The page stays the only place that signs in and refreshes: the frame never refreshes a token itself, because
 * a refresh token can be used once and a second holder would sign the web session out. It keeps the access
 * token in memory, and asks the page for a fresh one (`session.refresh`) when it is about to run out.
 * What is sent is the public project URL and publishable key (already in every page) and the short-lived
 * access token. The refresh token never leaves the web view.
 *
 * In a browser, the home-screen app and Android, `nativeFrame()` is null and none of this does anything.
 */
import type { Session } from "@supabase/supabase-js";
import { nativeFrame } from "./native-frame";
import { getSupabaseBrowserClient, supabaseConnection } from "./supabase";

export type NativeSessionMessage =
  | { signedIn: true; url: string; key: string; userId: string; accessToken: string; expiresAt: number }
  | { signedIn: false };

/** The `session` message for the frame. `expiresAt` is seconds since 1970, as Supabase reports it. */
export function sessionMessage(session: Session | null, connection: { url: string; key: string }): NativeSessionMessage {
  if (!session?.access_token || !session.user?.id) return { signedIn: false };
  const expiresAt = session.expires_at ?? Math.floor(Date.now() / 1000) + (session.expires_in ?? 0);
  return { signedIn: true, url: connection.url, key: connection.key, userId: session.user.id, accessToken: session.access_token, expiresAt };
}

/** Starts telling the frame about the session; returns the function that stops. Does nothing outside the frame. */
export function startNativeSession(): () => void {
  const frame = nativeFrame();
  const supabase = getSupabaseBrowserClient();
  if (!frame || !supabase) return () => undefined;
  const connection = supabaseConnection();
  const send = (session: Session | null) => frame.post("session", sessionMessage(session, connection));

  void supabase.auth.getSession().then(({ data }) => send(data.session));
  const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => send(session));

  // The frame asks when its token is about to run out (or the server turned it down). `force` makes the refresh
  // happen now rather than when supabase-js would have done it anyway.
  const stopListening = frame.on<{ force?: boolean }>("session.refresh", (request) => {
    const get = request?.force ? supabase.auth.refreshSession().then(({ data }) => data.session) : supabase.auth.getSession().then(({ data }) => data.session);
    void get.then(send);
  });

  return () => { subscription.subscription.unsubscribe(); stopListening(); };
}
