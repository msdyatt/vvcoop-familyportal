"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { PRIVATE_BUCKET, getSignedFileUrls, uploadPrivateFile } from "../../../lib/storage";
import { resizeImage } from "../../../lib/image-resize";
import { MESSAGE_COLUMNS, conversationTitle, dayLabel, shortTime, type ConversationRow, type MessageRow, type Person } from "../../../lib/messages";
import DetailModal from "../detail-modal";

const PAGE = 50;

export default function Thread({ conversation, userId, tick, onBack, onChanged }: {
  conversation: ConversationRow; userId: string; tick: number; onBack: () => void; onChanged: () => void | Promise<void>;
}) {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [people, setPeople] = useState<Map<string, Person>>(new Map());
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(new Map());
  const [draft, setDraft] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [reporting, setReporting] = useState<MessageRow | null>(null);
  const [reason, setReason] = useState("");
  const [viewing, setViewing] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const title = conversationTitle(conversation);

  const fetchLatest = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("messages").select(MESSAGE_COLUMNS)
      .eq("conversation_id", conversation.id).order("created_at", { ascending: false }).limit(PAGE);
    const rows = ((data ?? []) as MessageRow[]).reverse();
    setMessages((previous) => {
      // Keep anything older that was already loaded; replace the newest page.
      const oldest = rows[0]?.created_at;
      const kept = oldest ? previous.filter((row) => row.created_at < oldest) : [];
      return [...kept, ...rows];
    });
    setHasMore((data ?? []).length === PAGE);
  }, [conversation.id]);

  async function loadEarlier() {
    const supabase = getSupabaseBrowserClient();
    const oldest = messages[0]?.created_at;
    if (!supabase || !oldest) return;
    const { data } = await supabase.from("messages").select(MESSAGE_COLUMNS)
      .eq("conversation_id", conversation.id).lt("created_at", oldest).order("created_at", { ascending: false }).limit(PAGE);
    const rows = ((data ?? []) as MessageRow[]).reverse();
    stickToBottom.current = false;
    setMessages((previous) => [...rows, ...previous]);
    setHasMore((data ?? []).length === PAGE);
  }

  async function markRead() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    await supabase.rpc("mark_conversation_read", { p_conversation_id: conversation.id });
    await onChanged();
  }

  // Opening a conversation: who is in it, the latest messages, and mark it read.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    stickToBottom.current = true;
    (async () => {
      const { data } = await supabase.rpc("conversation_people", { p_conversation_id: conversation.id });
      setPeople(new Map(((data ?? []) as Person[]).map((person) => [person.user_id, person])));
      await fetchLatest();
      await markRead();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per conversation
  }, [conversation.id]);

  // A live event or the slow poll: look again, and keep it read while it is open.
  useEffect(() => {
    if (!tick) return;
    void fetchLatest();
    if (document.visibilityState === "visible") void markRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the tick only
  }, [tick]);

  // Photos: fetch a signed link for any that do not have one yet.
  useEffect(() => {
    const missing = messages.map((m) => m.image_path).filter((p): p is string => !!p && !imageUrls.has(p));
    if (!missing.length) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    void getSignedFileUrls(supabase, missing).then((urls) => setImageUrls((previous) => new Map([...previous, ...urls])));
  }, [messages, imageUrls]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
    stickToBottom.current = true;
  }, [messages.length, imageUrls.size]);

  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview); }, [photoPreview]);

  function chooseFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setStatus("Choose a photo (JPEG, PNG, or similar)."); return; }
    setStatus("");
    setPhoto(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  function clearPhoto() {
    setPhoto(null);
    setPhotoPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function send() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || busy) return;
    const body = draft.trim();
    if (!body && !photo) return;
    setBusy(true); setStatus("");
    try {
      let imagePath: string | null = null;
      if (photo) {
        const resized = await resizeImage(photo);
        const uploaded = await uploadPrivateFile(supabase, `messages/${conversation.id}`, resized);
        if ("error" in uploaded) throw new Error(uploaded.error);
        imagePath = uploaded.path;
      }
      const { error } = await supabase.rpc("send_message", { p_conversation_id: conversation.id, p_body: body || null, p_image_path: imagePath });
      if (error) {
        if (imagePath) void supabase.storage.from(PRIVATE_BUCKET).remove([imagePath]);
        throw new Error(error.message);
      }
      setDraft(""); clearPhoto();
      stickToBottom.current = true;
      await fetchLatest();
      await onChanged();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "That message could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  async function removeOwn(message: MessageRow) {
    if (!confirm("Remove this message for everyone?")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.rpc("delete_own_message", { p_message_id: message.id });
    if (error) { setStatus(error.message); return; }
    if (typeof data === "string" && data) void supabase.storage.from(PRIVATE_BUCKET).remove([data]);
    await fetchLatest();
    await onChanged();
  }

  async function submitReport() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !reporting) return;
    const { error } = await supabase.rpc("report_message", { p_message_id: reporting.id, p_reason: reason });
    if (error) { setStatus(error.message); return; }
    setReporting(null); setReason("");
    setStatus("Thank you. An administrator will look at this message.");
  }

  async function toggleMute() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    await supabase.rpc("set_conversation_muted", { p_conversation_id: conversation.id, p_muted: !conversation.muted });
    await onChanged();
  }

  async function blockOther() {
    if (!conversation.other_user_id) return;
    if (!confirm(`Block ${title}? They won't be able to message you, and you won't see their messages.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.rpc("block_user", { p_user: conversation.other_user_id });
    if (error) { setStatus(error.message); return; }
    await onChanged();
    onBack();
  }

  async function leave() {
    if (!confirm(`Leave ${title}? You will stop receiving its messages.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.rpc("leave_conversation", { p_conversation_id: conversation.id });
    if (error) { setStatus(error.message); return; }
    await onChanged();
    onBack();
  }

  let lastDay = "";
  return <div className="messages-thread">
    <header className="messages-thread-head">
      <button type="button" className="ghost messages-back" onClick={onBack} aria-label="Back to conversations">← Back</button>
      <div className="messages-thread-title">
        <b>{title}</b>
        {conversation.kind !== "direct" && <button type="button" className="messages-linkish" onClick={() => setShowMembers(true)}>{conversation.member_count} people</button>}
      </div>
      <div className="messages-thread-actions">
        <button type="button" className="ghost" onClick={toggleMute}>{conversation.muted ? "Unmute" : "Mute"}</button>
        {conversation.kind === "direct" && <button type="button" className="ghost" onClick={blockOther}>Block</button>}
        {conversation.kind === "group" && <button type="button" className="ghost" onClick={leave}>Leave</button>}
      </div>
    </header>

    <div className="messages-scroll" ref={listRef} onScroll={(event) => {
      const el = event.currentTarget;
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }}>
      {hasMore && <button type="button" className="ghost messages-earlier" onClick={loadEarlier}>Earlier messages</button>}
      {!messages.length && <p className="portal-empty">Say hello.</p>}
      {messages.map((message) => {
        const day = dayLabel(message.created_at);
        const showDay = day !== lastDay;
        lastDay = day;
        const mine = message.sender_id === userId;
        const sender = message.sender_id ? people.get(message.sender_id) : undefined;
        const url = message.image_path ? imageUrls.get(message.image_path) : undefined;
        return <div key={message.id}>
          {showDay && <div className="messages-day"><span>{day}</span></div>}
          <div className={`messages-bubble-row${mine ? " mine" : ""}`}>
            <div className={`messages-bubble${mine ? " mine" : ""}${message.deleted_at ? " removed" : ""}`}>
              {!mine && conversation.kind !== "direct" && <span className="messages-sender">
                {sender?.display_name ?? "Former member"}
                {sender?.is_teacher && <i>Teacher</i>}{sender?.is_admin && <i>Admin</i>}
              </span>}
              {message.deleted_at
                ? <em>Message removed</em>
                : <>
                    {url && <button type="button" className="messages-photo" onClick={() => setViewing(url)} aria-label="Open photo">
                      {/* eslint-disable-next-line @next/next/no-img-element -- a signed link to private storage; next/image can't optimize it */}
                      <img src={url} alt="Shared photo" loading="lazy" />
                    </button>}
                    {message.image_path && !url && <span className="messages-photo-loading">Loading photo…</span>}
                    {message.body && <p>{message.body}</p>}
                  </>}
              <span className="messages-meta">
                <time>{shortTime(message.created_at)}</time>
                {!message.deleted_at && mine && <button type="button" onClick={() => removeOwn(message)}>Remove</button>}
                {!message.deleted_at && !mine && <button type="button" onClick={() => { setReporting(message); setReason(""); }}>Report</button>}
              </span>
            </div>
          </div>
        </div>;
      })}
    </div>

    {status && <p className="admin-form-status messages-status" role="status">{status}</p>}

    {photoPreview && <div className="messages-attach">
      {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of the chosen file */}
      <img src={photoPreview} alt="Photo to send" />
      <button type="button" className="ghost" onClick={clearPhoto}>Remove photo</button>
    </div>}

    <form className="messages-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => chooseFile(event.target.files?.[0])} />
      <button type="button" className="ghost messages-attach-button" onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Add a photo">Photo</button>
      <textarea
        value={draft} rows={1} maxLength={4000} placeholder="Write a message"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && window.matchMedia("(min-width: 761px)").matches) { event.preventDefault(); void send(); } }}
        aria-label="Message" disabled={busy}
      />
      <button type="submit" disabled={busy || (!draft.trim() && !photo)}>{busy ? "Sending…" : "Send"}</button>
    </form>

    {reporting && <DetailModal title="Report this message" onClose={() => setReporting(null)}>
      <div className="portal-form">
        <p className="portal-empty">An administrator will see this message and a few around it. The person who sent it will not be told who reported it.</p>
        <label><span className="field-caption">What is wrong?</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} />
        </label>
        <div className="row-actions">
          <button type="button" disabled={!reason.trim()} onClick={submitReport}>Send report</button>
          <button type="button" className="ghost" onClick={() => setReporting(null)}>Cancel</button>
        </div>
      </div>
    </DetailModal>}

    {viewing && <DetailModal title="Photo" onClose={() => setViewing(null)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a signed link to private storage */}
      <img className="messages-lightbox" src={viewing} alt="Shared photo, full size" />
    </DetailModal>}

    {showMembers && <DetailModal title={`${title}: members`} onClose={() => setShowMembers(false)}>
      <ul className="messages-members">
        {[...people.values()].map((person) => <li key={person.user_id}>{person.display_name}{person.is_teacher && <i>Teacher</i>}{person.is_admin && <i>Admin</i>}</li>)}
      </ul>
    </DetailModal>}
  </div>;
}
