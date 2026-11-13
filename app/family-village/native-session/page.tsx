import NativeSessionReporter from "../native-session-reporter";

export const metadata = { title: "Session | Family Village" };

/**
 * A page with nothing on it. The iPhone app keeps it open out of sight while its native Messages screens are
 * in use, so there is always a web view to sign in, refresh the session and hand it over (lib/native-session.ts),
 * even when no other page is loaded. In a browser it is just blank.
 */
export default function NativeSessionPage() { return <NativeSessionReporter />; }
