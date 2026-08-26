"use client";

import { useRef, useState } from "react";
import RichText from "../../lib/rich-text";

export default function RichTextEditor({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [preview, setPreview] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);

  function wrap(before: string, after = before) {
    const field = editor.current;
    if (!field) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selection = value.slice(start, end) || "text";
    const next = `${value.slice(0, start)}${before}${selection}${after}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + before.length, start + before.length + selection.length); });
  }

  function link() {
    const field = editor.current;
    if (!field) return;
    const entered = window.prompt("Paste the web or email address for this link", "https://");
    if (!entered?.trim()) return;
    const raw = entered.trim();
    const href = /^(https?:\/\/|mailto:)/i.test(raw) ? raw : `https://${raw}`;
    wrap(`<a href="${href.replace(/"/g, "&quot;")}">`, "</a>");
  }

  return <div className="rich-editor">
    <div className="rich-editor-toolbar" role="toolbar" aria-label="News formatting">
      <button type="button" aria-pressed={!preview} className={!preview ? "active" : ""} onClick={() => setPreview(false)}>Write</button>
      <button type="button" aria-pressed={preview} className={preview ? "active" : ""} onClick={() => setPreview(true)}>Preview</button>
      {!preview && <>
        <span aria-hidden="true" />
        <button type="button" onClick={() => wrap("<strong>", "</strong>")} title="Bold"><b>B</b></button>
        <button type="button" onClick={() => wrap("<em>", "</em>")} title="Italic"><em>I</em></button>
        <button type="button" onClick={() => wrap("<h3>", "</h3>")} title="Heading">Heading</button>
        <button type="button" onClick={() => wrap("<ul>\n  <li>", "</li>\n</ul>")} title="Bulleted list">List</button>
        <button type="button" onClick={link} title="Link">Link</button>
      </>}
    </div>
    {preview
      ? <div className="rich-editor-preview"><RichText html={value} />{!value.trim() && <p className="portal-empty">Your formatted preview will appear here.</p>}</div>
      : <textarea ref={editor} required aria-label="News body HTML" placeholder="Write the story here. Use the formatting buttons or simple HTML." value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} />}
  </div>;
}
