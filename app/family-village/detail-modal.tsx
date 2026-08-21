"use client";

import { useEffect } from "react";

export default function DetailModal({ title, onClose, children }: { title?: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return <div className="child-detail-overlay" role="dialog" aria-modal="true">
    {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- decorative backdrop; Escape and the close button provide keyboard access */}
    <div className="child-detail-backdrop" onClick={onClose} />
    <div className="child-detail-panel">
      <button className="child-detail-close" onClick={onClose} aria-label="Close">×</button>
      {title && <h2>{title}</h2>}
      {children}
    </div>
  </div>;
}
