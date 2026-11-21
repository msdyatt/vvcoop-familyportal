/**
 * What a page shows in its content area while it works out who you are and
 * fetches its data. The header and the bottom bar are already on screen, so
 * moving between pages reads as the content changing, not the whole app going
 * blank and starting again.
 *
 * On top sits the loading animation the iPhone app also uses (InkLoadingView.swift): three ink diamonds hopping in
 * turn over a line that inks itself in, with a caption that changes if the wait runs long, so it is always clear the
 * page is working. Motion follows the device's reduced-motion setting and the co-op's own switch.
 */
export default function PageSkeleton() {
  return <div className="vv-skeleton" role="status" aria-busy="true">
    <div className="vv-ink-loader">
      <svg viewBox="0 0 120 44" width="120" height="44" aria-hidden="true">
        <path className="vv-ink-diamond" d="M38 9l5 5-5 5-5-5z" />
        <path className="vv-ink-diamond" d="M60 9l5 5-5 5-5-5z" />
        <path className="vv-ink-diamond" d="M82 9l5 5-5 5-5-5z" />
        <path className="vv-ink-line" pathLength="100" d="M4 36C24 31 38 40 60 35S96 31 116 33" />
      </svg>
      <p className="vv-ink-caption"><span>Loading…</span><span aria-hidden="true">Still working on it…</span></p>
    </div>
    <span className="vv-skeleton-line wide" />
    <span className="vv-skeleton-block" />
    <span className="vv-skeleton-line" />
    <span className="vv-skeleton-block short" />
  </div>;
}
