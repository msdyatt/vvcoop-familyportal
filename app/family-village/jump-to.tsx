"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ADMIN_PATH, ADMIN_TAB_EVENT, jumpEntries, searchJump, type JumpEntry } from "../../lib/desktop-nav";

const EXAMPLES = ["dues", "waiver", "photos", "print", "calendar"];

/**
 * "Jump to…": finds any page by its name or an everyday word for it ("pay", "waiver", "printer"). Opens from the
 * header button, from "/" anywhere outside a text field, or from Ctrl+K / Cmd+K. Desktop only (CSS).
 */
export default function JumpTo({ roles }: { roles: string[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [example, setExample] = useState(EXAMPLES[0]);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const entries = useMemo(() => jumpEntries(roles), [roles]);
  const results = useMemo(() => searchJump(entries, query), [entries, query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target?.closest("input, textarea, select, [contenteditable=true]");
      if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey)) {
        // Only on screens where the button is showing (the desktop layout).
        if (!trigger.current || trigger.current.offsetParent === null) return;
        event.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a fresh example each time it opens
    setExample(EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)]);
    const frame = window.requestAnimationFrame(() => input.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  function close() {
    setOpen(false);
    setQuery("");
    setCursor(0);
    trigger.current?.focus();
  }

  function go(entry: JumpEntry) {
    if (entry.adminTab && window.location.pathname.startsWith(ADMIN_PATH)) {
      window.dispatchEvent(new CustomEvent(ADMIN_TAB_EVENT, { detail: entry.adminTab }));
      close();
      return;
    }
    window.location.assign(entry.href);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); setCursor((n) => Math.min(n + 1, results.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setCursor((n) => Math.max(n - 1, 0)); }
    else if (event.key === "Enter" && results[cursor]) { event.preventDefault(); go(results[cursor]); }
  }

  return <>
    <button ref={trigger} type="button" className="jump-to-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
      <span>Jump to a page</span>
      <kbd aria-hidden="true">/</kbd>
    </button>

    {/* On <body>, so no header layer can sit over it. */}
    {open && createPortal(<div className="jump-to-scrim">
      <button type="button" className="jump-to-backdrop" tabIndex={-1} aria-label="Close" onClick={close} />
      <div className="jump-to-panel" role="dialog" aria-modal="true" aria-label="Jump to a page">
        <label className="jump-to-field">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
          <span className="sr-only">Page name</span>
          <input ref={input} type="text" value={query} placeholder={`Where to? Try “${example}”`} autoComplete="off" spellCheck={false}
            role="combobox" aria-expanded="true" aria-controls="jump-to-results" aria-autocomplete="list"
            aria-activedescendant={results[cursor] ? `jump-${results[cursor].id}` : undefined}
            onKeyDown={onKeyDown} onChange={(event) => { setQuery(event.target.value); setCursor(0); }} />
          <kbd aria-hidden="true">Esc</kbd>
        </label>

        {results.length ? <ul id="jump-to-results" className="jump-to-results" role="listbox" aria-label="Pages">
          {/* The keyboard drives the list from the field above (aria-activedescendant), so the options only need the mouse. */}
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events */}
          {results.map((entry, index) => <li key={entry.id} id={`jump-${entry.id}`} role="option" aria-selected={index === cursor}
            className={index === cursor ? "on" : ""} onMouseEnter={() => setCursor(index)} onClick={() => go(entry)}>
            <span className="jump-to-diamond" aria-hidden="true" />
            <span className="jump-to-label">{entry.label}</span>
            {entry.trail && <span className="jump-to-trail">{entry.trail}</span>}
            {index === cursor && <kbd aria-hidden="true">Enter</kbd>}
          </li>)}
        </ul> : <div className="jump-to-empty" role="status">
          <svg viewBox="0 0 64 48" width="64" height="48" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="26" cy="20" r="12" /><path d="M35 29l12 12" strokeWidth="2.4" /><path d="M20 15c1.5-2 4-3 6-3" strokeWidth=".7" />
            <path d="M52 8l1 2.2 2.2 1-2.2 1-1 2.2-1-2.2-2.2-1 2.2-1zM8 34l.8 1.6 1.6.8-1.6.8-.8 1.6-.8-1.6-1.6-.8 1.6-.8z" strokeWidth=".8" />
          </svg>
          <p>No page by that name. Try &ldquo;dues&rdquo;, &ldquo;waiver&rdquo; or &ldquo;photos&rdquo;.</p>
        </div>}
        <p className="jump-to-hint" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> to choose · <kbd>Enter</kbd> to go</p>
      </div>
    </div>, document.body)}
  </>;
}
