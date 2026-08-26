"use client";

import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import { getSignedFileUrl, uploadPrivateFile } from "../../lib/storage";
import { resolveInlineImages } from "../../lib/rich-text";

function escapeForInsert(value: string) {
  return value.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[character] ?? character));
}

/**
 * A real WYSIWYG editor over a contentEditable surface, not a textarea of raw
 * HTML with a separate preview toggle -- what you see while writing is what
 * gets saved.
 *
 * Formatting buttons insert exact tags via execCommand("insertHTML", ...)
 * rather than execCommand("bold"/"italic"/"formatBlock"), which produce
 * different tags across browsers (<b> vs <strong>, a wrapping <div>, ...).
 * insertHTML puts the precise tag the sanitizer's allow-list expects, so
 * formatting can't silently vanish on save the way a browser-chosen tag
 * outside that allow-list would.
 *
 * The editor only seeds its content ONCE, from the value it mounted with --
 * resyncing on every prop change (the normal controlled-input pattern) would
 * fight the browser's own cursor position on every keystroke, since onInput
 * pushes a new value up on every character typed. To load a different post,
 * give this component a fresh `key` (news-tab.tsx keys it by the id being
 * edited) so React remounts it instead of trying to resync it in place.
 */
export default function RichTextEditor({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    resolveInlineImages(value).then((resolved) => {
      if (!cancelled && editorRef.current) editorRef.current.innerHTML = resolved;
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seeds the editor once on mount only, by design (see comment above)
  }, []);

  function sync() {
    if (editorRef.current) onChange(editorRef.current.innerHTML);
  }

  /** Wraps the current selection (or inserts placeholder text) in `before`/`after`. */
  function insertAround(before: string, after: string) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    const selectedText = range && editor.contains(range.commonAncestorContainer) ? range.toString() : "";
    document.execCommand("insertHTML", false, `${before}${escapeForInsert(selectedText || "text")}${after}`);
    sync();
  }

  function link() {
    const entered = window.prompt("Paste the web or email address for this link", "https://");
    if (!entered?.trim()) return;
    const raw = entered.trim();
    const href = /^(https?:\/\/|mailto:)/i.test(raw) ? raw : `https://${raw}`;
    insertAround(`<a href="${href.replace(/"/g, "&quot;")}">`, "</a>");
  }

  async function insertImage(file: File) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setUploading(true); setStatus("");
    const uploaded = await uploadPrivateFile(supabase, "news", file);
    if ("error" in uploaded) { setUploading(false); setStatus(uploaded.error); return; }
    const previewUrl = await getSignedFileUrl(supabase, uploaded.path);
    setUploading(false);
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    document.execCommand("insertHTML", false, `<img data-path="${uploaded.path}" alt="" src="${previewUrl ?? ""}">`);
    sync();
  }

  return <div className="rich-editor">
    <div className="rich-editor-toolbar" role="toolbar" aria-label="News formatting">
      <button type="button" onClick={() => insertAround("<strong>", "</strong>")} title="Bold" disabled={disabled}><b>B</b></button>
      <button type="button" onClick={() => insertAround("<em>", "</em>")} title="Italic" disabled={disabled}><em>I</em></button>
      <button type="button" onClick={() => insertAround("<h3>", "</h3>")} title="Heading" disabled={disabled}>Heading</button>
      <button type="button" onClick={() => insertAround("<ul>\n  <li>", "</li>\n</ul>")} title="Bulleted list" disabled={disabled}>List</button>
      <button type="button" onClick={link} title="Link" disabled={disabled}>Link</button>
      <span aria-hidden="true" />
      <button type="button" onClick={() => fileInput.current?.click()} title="Insert image" disabled={disabled || uploading}>{uploading ? "Uploading…" : "Image"}</button>
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) insertImage(file);
      }} />
    </div>
    <div
      ref={editorRef}
      className="rich-editor-surface rich-text"
      contentEditable={!disabled}
      role="textbox"
      aria-multiline="true"
      aria-label="News body"
      onInput={sync}
      suppressContentEditableWarning
    />
    {status && <p className="admin-form-status" role="status">{status}</p>}
  </div>;
}
