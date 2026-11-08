/**
 * The one loading screen. Every page used to show its own headline while it
 * waited ("Opening your messages…", "Gathering your village…"), so opening the
 * app flashed several different screens in a row. Now they are all this, so a
 * run of waits reads as a single quiet one: centred in the visible screen,
 * not scrollable, no text to read.
 */
export default function LoadingScreen({ label = "Loading" }: { label?: string }) {
  return <main className="vv-loading" role="status" aria-label={label}>
    {/* eslint-disable-next-line @next/next/no-img-element -- a small static brand mark; nothing to optimise */}
    <img src="/brand/icon-192.png" alt="" width={72} height={72} />
    <span className="vv-spinner" aria-hidden="true" />
  </main>;
}
