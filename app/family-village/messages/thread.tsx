"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { PRIVATE_BUCKET, getSignedFileUrls, uploadPrivateFile } from "../../../lib/storage";
import { resizeImage } from "../../../lib/image-resize";
import { MESSAGE_COLUMNS, REACTIONS, conversationTitle, dayLabel, isChannel, postingBlock, shortTime, snippet, splitMentions, type ConversationRow, type MessageRow, type Person, type Reaction } from "../../../lib/messages";
import Avatar from "../avatar";
import DetailModal from "../detail-modal";
import ChannelDetails from "./channel-details";

const PAGE = 50;

/**
 * Pairs each message with its day label, and whether it starts a run: the
 * first of a day, or a different sender, or a gap of ten minutes. Only the
 * first message of a run shows a name and a photo, as in a text conversation.
 */
function withDaySeparators(messages: MessageRow[]) {
  let previousDay = "";
  let previous: MessageRow | null = null;
  return messages.map((message) => {
    const day = dayLabel(message.created_at);
    const showDay = day !== previousDay;
    const startsRun = showDay || !previous || previous.sender_id !== message.sender_id || previous.post_id !== message.post_id
      || new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() > RUN_MS;
    previousDay = day;
    previous = message;
    return { message, day, showDay, startsRun };
  });
}

const RUN_MS = 10 * 60_000;

export default function Thread({ conversation, userId, roles, tick, onBack, onChanged }: {
  conversation: ConversationRow; userId: string; roles: string[]; tick: number; onBack: () => void; onChanged: () => void | Promise<void>;
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
  const [avatarUrls, setAvatarUrls] = useState<Map<string, string>>(new Map());
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<MessageRow | null>(null);
  // People chosen from the @ list: display name -> id. Kept only if the name is still in the text when sending.
  const [mentionIds, setMentionIds] = useState<Map<string, string>>(new Map());
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const title = conversationTitle(conversation);
  const channel = isChannel(conversation);
  const blocked = postingBlock(conversation, roles);
  const archivedBlock = !!conversation.archived_at;
  const mentionNames = [...people.values()].map((person) => person.display_name);
  const myName = people.get(userId)?.display_name ?? "";

  const fetchLatest = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("messages").select(MESSAGE_COLUMNS)
      .eq("conversation_id", conversation.id).order("created_at", { ascending: false }).limit(PAGE);
    const rows = ((data ?? []) as unknown as MessageRow[]).reverse();
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
    const rows = ((data ?? []) as unknown as MessageRow[]).reverse();
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refetch when the live feed or poll fires
    void fetchLatest();
    if (document.visibilityState === "visible") void markRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the tick only
  }, [tick]);

  // Reactions on the messages currently loaded; looked at again on every live event.
  const loadedIds = messages.map((m) => m.id).join(",");
  const fetchReactions = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    const ids = loadedIds ? loadedIds.split(",") : [];
    if (!supabase || !ids.length) { setReactions([]); return; }
    const { data } = await supabase.from("message_reactions").select("message_id,user_id,emoji").in("message_id", ids);
    setReactions((data ?? []) as Reaction[]);
  }, [loadedIds]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load reactions when the set of messages changes
    void fetchReactions();
  }, [fetchReactions, tick]);

  async function react(messageId: string, emoji: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setPickerFor(null);
    const { error } = await supabase.rpc("toggle_reaction", { p_message_id: messageId, p_emoji: emoji });
    if (error) { setStatus(error.message); return; }
    await fetchReactions();
  }

  // Profile photos of the people in this conversation, for the bubbles.
  useEffect(() => {
    const paths = [...people.values()].map((person) => person.avatar_path).filter((path): path is string => !!path);
    if (!paths.length) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    void getSignedFileUrls(supabase, paths).then(setAvatarUrls);
  }, [people]);

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
      const mentions = [...mentionIds].filter(([name]) => body.includes(`@${name}`)).map(([, id]) => id);
      const { error } = await supabase.rpc("send_message", {
        p_conversation_id: conversation.id, p_body: body || null, p_image_path: imagePath,
        p_reply_to: replyingTo?.id ?? null, p_mentions: mentions,
      });
      if (error) {
        if (imagePath) void supabase.storage.from(PRIVATE_BUCKET).remove([imagePath]);
        throw new Error(error.message);
      }
      setDraft(""); clearPhoto(); setReplyingTo(null); setMentionIds(new Map()); setMentionQuery(null);
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

  const needle = (mentionQuery ?? "").toLowerCase();
  const mentionMatches = mentionQuery === null ? [] : [...people.values()]
    .filter((person) => person.user_id !== userId && person.display_name.toLowerCase().includes(needle)).slice(0, 5);

  function chooseMention(person: Person) {
    const caret = composerRef.current?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(/@[^\s@]{0,30}$/, `@${person.display_name} `);
    setDraft(before + draft.slice(caret));
    setMentionIds(new Map(mentionIds).set(person.display_name, person.user_id));
    setMentionQuery(null);
    composerRef.current?.focus();
  }

  const rows = withDaySeparators(messages);
  return <div className="messages-thread">
    <header className="messages-thread-head">
      <button type="button" className="messages-icon-btn messages-back" onClick={onBack} aria-label="Back to conversations">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>
      </button>
      <div className="messages-thread-title">
        <b>{channel ? `# ${title}` : title}</b>
        <span className="messages-topic">
          {channel ? conversation.topic ?? `${conversation.member_count} people` : conversation.kind === "direct" ? "" : `${conversation.member_count} people`}
          {conversation.muted ? " · Muted" : ""}
        </span>
      </div>
      <button type="button" className="messages-icon-btn" onClick={() => setShowMembers(true)} aria-label="Conversation details">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </button>
    </header>

    <div className="messages-scroll" ref={listRef} onScroll={(event) => {
      const el = event.currentTarget;
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }}>
      {hasMore && <button type="button" className="ghost messages-earlier" onClick={loadEarlier}>Earlier messages</button>}
      {!messages.length && <p className="portal-empty">Say hello.</p>}
      {rows.map(({ message, day, showDay, startsRun }) => {
        const mine = message.sender_id === userId;
        const sender = message.sender_id ? people.get(message.sender_id) : undefined;
        const url = message.image_path ? imageUrls.get(message.image_path) : undefined;
        const group = conversation.kind !== "direct";
        const announcement = !!message.post_id && !message.deleted_at;
        const [headline, ...rest] = (message.body ?? "").split("\n");
        const own = reactions.filter((r) => r.message_id === message.id);
        const chips = REACTIONS.map((emoji) => ({ emoji, count: own.filter((r) => r.emoji === emoji).length, mine: own.some((r) => r.emoji === emoji && r.user_id === userId) })).filter((chip) => chip.count > 0);
        return <div key={message.id} id={`msg-${message.id}`}>
          {showDay && <div className="messages-day"><span>{day}</span></div>}
          <div className={`messages-bubble-row${mine ? " mine" : ""}${startsRun ? " run-start" : ""}`}>
            {group && !mine && (startsRun
              ? <Avatar url={sender?.avatar_path ? avatarUrls.get(sender.avatar_path) ?? null : null} label={(sender?.display_name ?? "?").slice(0, 1)} size="md" />
              : <span className="messages-avatar-gap" aria-hidden="true" />)}
            <div className={`messages-bubble${mine ? " mine" : ""}${message.deleted_at ? " removed" : ""}${announcement ? " announcement" : ""}`}>
              {!mine && group && startsRun && <span className="messages-sender">
                {sender?.display_name ?? "Former member"}
                {sender?.is_teacher && <i>Teacher</i>}{sender?.is_admin && <i>Admin</i>}
              </span>}
              {message.deleted_at
                ? <em>Message removed</em>
                : <>
                    {url && <button type="button" className="messages-photo" onClick={() => setViewing(url)} aria-label="Open photo">
                      {/* eslint-disable-next-line @next/next/no-img-element -- a signed link to private storage; next/image can't optimize it */}
                      <img src={url} alt="Attachment" loading="lazy" />
                    </button>}
                    {message.image_path && !url && <span className="messages-photo-loading">Loading photo…</span>}
                    {message.reply_to && message.reply && <a className="messages-quote" href={`#msg-${message.reply.id}`}>
                      <b>{message.reply.sender_id === userId ? "You" : people.get(message.reply.sender_id ?? "")?.display_name ?? "Former member"}</b>
                      <span>{snippet(message.reply)}</span>
                    </a>}
                    {announcement
                      ? <>
                          <span className="messages-announce-tag">News</span>
                          <p><b>{headline}</b></p>
                          {rest.length > 0 && <p>{rest.join("\n")}</p>}
                          <a className="messages-announce-link" href="/family-village/home#news">Read in News</a>
                        </>
                      : message.body && <p>{splitMentions(message.body, mentionNames).map((part, index) => part.mention
                          ? <span key={index} className={`messages-mention${part.text === `@${myName}` ? " me" : ""}`}>{part.text}</span>
                          : part.text)}</p>}
                  </>}
              {chips.length > 0 && !message.deleted_at && <span className="messages-reactions">
                {chips.map((chip) => <button key={chip.emoji} type="button" className={`messages-chip${chip.mine ? " mine" : ""}`} onClick={() => void react(message.id, chip.emoji)}
                  aria-label={`${chip.emoji} ${chip.count}${chip.mine ? ", you reacted" : ""}`} aria-pressed={chip.mine}>{chip.emoji} {chip.count}</button>)}
              </span>}
              {pickerFor === message.id && <span className="messages-picker" role="group" aria-label="Choose a reaction">
                {REACTIONS.map((emoji) => <button key={emoji} type="button" onClick={() => void react(message.id, emoji)} aria-label={`React ${emoji}`}>{emoji}</button>)}
              </span>}
              <span className="messages-meta">
                <time>{shortTime(message.created_at)}</time>
                {!message.deleted_at && !archivedBlock && <button type="button" onClick={() => setPickerFor(pickerFor === message.id ? null : message.id)}>React</button>}
                {!message.deleted_at && !blocked && <button type="button" onClick={() => { setReplyingTo(message); composerRef.current?.focus(); }}>Reply</button>}
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
      <img src={photoPreview} alt="Attachment preview" />
      <button type="button" className="ghost" onClick={clearPhoto}>Remove photo</button>
    </div>}

    {replyingTo && !blocked && <div className="messages-replying">
      <span>Replying to <b>{replyingTo.sender_id === userId ? "yourself" : people.get(replyingTo.sender_id ?? "")?.display_name ?? "Former member"}</b>: {snippet(replyingTo, 60)}</span>
      <button type="button" className="messages-icon-btn" onClick={() => setReplyingTo(null)} aria-label="Cancel reply">×</button>
    </div>}

    {mentionQuery !== null && !blocked && mentionMatches.length > 0 && <ul className="messages-suggest" role="listbox" aria-label="Mention someone">
      {mentionMatches.map((person) => <li key={person.user_id}>
        <button type="button" role="option" aria-selected="false" onClick={() => chooseMention(person)}>{person.display_name}{person.is_teacher && <i>Teacher</i>}{person.is_admin && <i>Admin</i>}</button>
      </li>)}
    </ul>}

    {blocked ? <p className="messages-readonly" role="note">{blocked}</p> : <form className="messages-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => chooseFile(event.target.files?.[0])} />
      <button type="button" className="messages-icon-btn messages-attach-button" onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Add a photo">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="3" /><circle cx="12" cy="12.5" r="3.5" /><path d="M8.5 5 9.7 3h4.6l1.2 2" /></svg>
      </button>
      <textarea
        ref={composerRef}
        value={draft} rows={1} maxLength={4000} placeholder="Write a message"
        onChange={(event) => {
          const value = event.target.value;
          setDraft(value);
          // An @ at the start of a word opens the list of people to mention.
          const token = /(?:^|\s)@([^\s@]{0,30})$/.exec(value.slice(0, event.target.selectionStart ?? value.length));
          setMentionQuery(token && conversation.kind !== "direct" ? token[1] : null);
        }}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && window.matchMedia("(min-width: 761px)").matches) { event.preventDefault(); void send(); } }}
        aria-label="Message" disabled={busy}
      />
      <button type="submit" className="messages-icon-btn send" disabled={busy || (!draft.trim() && !photo)} aria-label={busy ? "Sending" : "Send"}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V6M6 11l6-6 6 6" /></svg>
      </button>
    </form>}

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
      <img className="messages-lightbox" src={viewing} alt="Attachment, full size" />
    </DetailModal>}

    {showMembers && channel && <DetailModal title={`# ${title}`} onClose={() => setShowMembers(false)}>
      <ChannelDetails conversation={conversation} userId={userId} roles={roles} people={[...people.values()]} onToggleMute={toggleMute}
        onChanged={async () => {
          const supabase = getSupabaseBrowserClient();
          if (supabase) {
            const { data } = await supabase.rpc("conversation_people", { p_conversation_id: conversation.id });
            setPeople(new Map(((data ?? []) as Person[]).map((person) => [person.user_id, person])));
          }
          await onChanged();
        }}
        onLeft={() => { setShowMembers(false); onBack(); }} onClose={() => setShowMembers(false)} />
    </DetailModal>}

    {showMembers && !channel && <DetailModal title={title} onClose={() => setShowMembers(false)}>
      {conversation.kind !== "direct" && <ul className="messages-members">
        {[...people.values()].map((person) => <li key={person.user_id}>{person.display_name}{person.is_teacher && <i>Teacher</i>}{person.is_admin && <i>Admin</i>}</li>)}
      </ul>}
      <div className="bar-footer">
        <button type="button" className="ghost" onClick={() => { setShowMembers(false); void toggleMute(); }}>{conversation.muted ? "Unmute" : "Mute"}</button>
        {conversation.kind === "direct" && <button type="button" className="ghost" onClick={() => { setShowMembers(false); void blockOther(); }}>Block</button>}
        {conversation.kind === "group" && <button type="button" className="ghost" onClick={() => { setShowMembers(false); void leave(); }}>Leave group</button>}
        <button type="button" onClick={() => setShowMembers(false)}>Done</button>
      </div>
    </DetailModal>}
  </div>;
}
