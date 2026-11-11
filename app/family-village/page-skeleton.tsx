/**
 * What a page shows in its content area while it works out who you are and
 * fetches its data. The header and the bottom bar are already on screen, so
 * moving between pages reads as the content changing, not the whole app going
 * blank and starting again.
 */
export default function PageSkeleton() {
  return <div className="vv-skeleton" role="status" aria-label="Loading" aria-busy="true">
    <span className="vv-skeleton-line wide" />
    <span className="vv-skeleton-block" />
    <span className="vv-skeleton-line" />
    <span className="vv-skeleton-block short" />
  </div>;
}
