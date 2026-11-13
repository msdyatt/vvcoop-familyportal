"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { PRIVATE_BUCKET, getSignedFileUrls, uploadPrivateFile } from "../../../lib/storage";
import { resizeImage } from "../../../lib/image-resize";
import { ATTACH_ACCEPT, ATTACH_MAX, FILE_MAX_BYTES, MESSAGE_COLUMNS, REACTIONS, canEditMessage, classifyFile, formatBytes, type Attachment, conversationTitle, dayLabel, isChannel, postingBlock, shortTime, snippet, splitMentions, type ConversationRow, type MessageRow, type Person, type Reaction } from "../../../lib/messages";
import Avatar from "../avatar";
import DetailModal from "../detail-modal";
import ChannelDetails from "./channel-details";
import { EMOJI_GROUPS } from "../../../lib/emoji";
import ConversationAvatar from "./conversation-avatar";
import { FLAVOUR_LABEL, conversationFlavour, conversationTone, roleRing, toneFor } from "../../../lib/message-colors";

const PAGE = 50;

type Pending = { id: string; file: File; kind: "image" | "file"; previewUrl: string | null };

/**
 * Pairs each message with its day label, and where it sits in a run: a run is
 * the messages one person sends in a row, with under ten minutes between them
 * and none on another day. The first of a run carries the name, the last
 * carries the photo and the time, and the bubbles in between sit close
 * together, as in a text conversation. News and system cards stand alone.
 */
function withDaySeparators(messages: MessageRow[]) {
  let previousDay = "";
  let previous: MessageRow | null = null;
  const items = messages.map((message) => {
    const day = dayLabel(message.created_at);
    const showDay = day !== previousDay;
    const card = isCard(message);
    const startsRun = showDay || !previous || card || isCard(previous) || previous.sender_id !== message.sender_id || previous.post_id !== message.post_id
      || new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() > RUN_MS;
    previousDay = day;
    previous = message;
    return { message, day, showDay, startsRun, card };
  });
  return items.map((item, index) => ({ ...item, endsRun: item.card || index === items.length - 1 || items[index + 1].startsRun }));
}

/** News posts and system messages (a report, say) are shown as cards, not bubbles. */
const isCard = (message: MessageRow) => (!!message.post_id || !!message.system_label) && !message.deleted_at;

const RUN_MS = 10 * 60_000;

/** "Maria", "Maria and James", "Maria, James and Ana". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export default function Thread({ conversation, userId, roles, tick, onBack, onChanged }: {
  conversation: ConversationRow; userId: string; roles: string[]; tick: number; onBack: () => void; onChanged: () => void | Promise<void>;
}) {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [people, setPeople] = useState<Map<string, Person>>(new Map());
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(new Map());
  const [draft, setDraft] = useState("");
  // Photos and files chosen for the next message, not yet sent.
  const [pending, setPending] = useState<Pending[]>([]);
  // Photos and files already sent, by message.
  const [attachments, setAttachments] = useState<Map<string, Attachment[]>>(new Map());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [reporting, setReporting] = useState<MessageRow | null>(null);
  const [reason, setReason] = useState("");
  const [viewing, setViewing] = useState<{ urls: string[]; index: number } | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  // For a conversation about a student: adults of that student who have not joined the portal yet.
  const [notInPortal, setNotInPortal] = useState<string[]>([]);
  const [avatarUrls, setAvatarUrls] = useState<Map<string, string>>(new Map());
  const [reactions, setReactions] = useState<Reaction[]>([]);
  // The message whose reactions are being listed ("who reacted").
  const [reactionsFor, setReactionsFor] = useState<string | null>(null);
  const [emojiGroup, setEmojiGroup] = useState(EMOJI_GROUPS[0].id);
  // The message whose actions (react, reply, remove, report) are showing; tap a message to open them.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // For people who run a channel: how many have seen each message, and the list for one.
  const [seenCounts, setSeenCounts] = useState<Map<string, { seen: number; total: number }>>(new Map());
  const [seenOff, setSeenOff] = useState(false);
  const [seenList, setSeenList] = useState<{ messageId: string; rows: { user_id: string; display_name: string; avatar_path: string | null; seen: boolean }[] | null } | null>(null);
  // A message of yours being edited in place: its id and the text so far.
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
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
      if (conversation.child_thread) {
        const { data: missing } = await supabase.rpc("child_thread_not_in_portal", { p_conversation_id: conversation.id });
        setNotInPortal(Array.isArray(missing) ? (missing as string[]) : []);
      }
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

  // "Seen by" is for administrators, teachers and the person who made the channel, in channels and class chats only.
  const mayWatchReads = isChannel(conversation) && !seenOff && (roles.includes("admin") || roles.includes("teacher") || conversation.created_by === userId);
  useEffect(() => {
    if (!mayWatchReads || !loadedIds) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    let cancelled = false;
    void supabase.rpc("message_seen_counts", { p_conversation_id: conversation.id, p_message_ids: loadedIds.split(",").slice(-100) }).then(({ data, error }) => {
      if (cancelled) return;
      // Someone the database does not count as staff (a teacher by class assignment only, say) just does not get the feature.
      if (error) { setSeenOff(true); return; }
      setSeenCounts(new Map(((data ?? []) as { message_id: string; seen_count: number; total_count: number }[]).map((row) => [row.message_id, { seen: row.seen_count, total: row.total_count }])));
    });
    return () => { cancelled = true; };
  }, [mayWatchReads, loadedIds, tick, conversation.id]);

  async function openSeen(messageId: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setSeenList({ messageId, rows: null });
    const { data, error } = await supabase.rpc("message_seen_by", { p_message_id: messageId });
    if (error) { setSeenList(null); setStatus(error.message); return; }
    setSeenList({ messageId, rows: (data ?? []) as { user_id: string; display_name: string; avatar_path: string | null; seen: boolean }[] });
  }

  async function react(messageId: string, emoji: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setActiveId(null);
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

  // Photos and files on messages: load the list for any message that has some and has not been loaded yet.
  const toLoad = messages.filter((m) => m.has_attachments && !attachments.has(m.id)).map((m) => m.id).join(",");
  useEffect(() => {
    if (!toLoad) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const ids = toLoad.split(",");
    void supabase.from("message_attachments").select("id,message_id,position,kind,path,name,mime,size_bytes").in("message_id", ids).order("position").then(({ data }) => {
      const grouped = new Map<string, Attachment[]>(ids.map((id) => [id, []]));
      for (const row of (data ?? []) as Attachment[]) grouped.get(row.message_id)?.push(row);
      setAttachments((previous) => new Map([...previous, ...grouped]));
    });
  }, [toLoad]);

  // Fetch a signed link for any photo or file that does not have one yet.
  useEffect(() => {
    const paths = [...messages.map((m) => m.image_path), ...[...attachments.values()].flat().map((a) => a.path)];
    const missing = [...new Set(paths)].filter((p): p is string => !!p && !imageUrls.has(p));
    if (!missing.length) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    void getSignedFileUrls(supabase, missing).then((urls) => setImageUrls((previous) => new Map([...previous, ...urls])));
  }, [messages, attachments, imageUrls]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
    stickToBottom.current = true;
  }, [messages.length, imageUrls.size, attachments.size]);

  // Free the local previews when the conversation closes.
  const pendingRef = useRef(pending);
  useEffect(() => { pendingRef.current = pending; });
  useEffect(() => () => { pendingRef.current.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); }); }, []);

  function chooseFiles(list: FileList | null) {
    if (!list?.length) return;
    const next = [...pending];
    let problem = "";
    for (const file of Array.from(list)) {
      const kind = classifyFile(file);
      if (!kind) { problem = `${file.name} is not a photo, PDF, Word, PowerPoint, Excel or CSV file.`; continue; }
      if (kind.kind === "file" && file.size > FILE_MAX_BYTES) { problem = `${file.name} is over 10 MB.`; continue; }
      if (next.length >= ATTACH_MAX) { problem = `Add up to ${ATTACH_MAX} photos or files to one message.`; break; }
      next.push({ id: crypto.randomUUID(), file, kind: kind.kind, previewUrl: kind.kind === "image" ? URL.createObjectURL(file) : null });
    }
    setStatus(problem);
    setPending(next);
    if (fileRef.current) fileRef.current.value = "";
  }

  function removePending(id: string) {
    const gone = pending.find((item) => item.id === id);
    if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
    setPending((items) => items.filter((item) => item.id !== id));
  }

  async function send() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || busy) return;
    const body = draft.trim();
    if (!body && !pending.length) return;
    setBusy(true); setStatus("");
    const uploadedPaths: string[] = [];
    try {
      // Photos are shrunk (and stripped of location data) first; documents go up as they are.
      const sent = [];
      for (const item of pending) {
        const file = item.kind === "image" ? await resizeImage(item.file) : item.file;
        const kind = classifyFile(item.file);
        const upload = item.kind === "image" ? file : new File([file], file.name, { type: kind?.mime ?? file.type });
        const uploaded = await uploadPrivateFile(supabase, `messages/${conversation.id}`, upload);
        if ("error" in uploaded) throw new Error(uploaded.error);
        uploadedPaths.push(uploaded.path);
        sent.push({ path: uploaded.path, name: item.file.name.slice(0, 160), mime: upload.type, size: upload.size });
      }
      const mentions = [...mentionIds].filter(([name]) => body.includes(`@${name}`)).map(([, id]) => id);
      const { error } = await supabase.rpc("send_message", {
        p_conversation_id: conversation.id, p_body: body || null,
        p_reply_to: replyingTo?.id ?? null, p_mentions: mentions, p_attachments: sent,
      });
      if (error) throw new Error(error.message);
      pending.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); });
      setDraft(""); setPending([]); setReplyingTo(null); setMentionIds(new Map()); setMentionQuery(null);
      stickToBottom.current = true;
      await fetchLatest();
      await onChanged();
    } catch (error) {
      if (uploadedPaths.length) void supabase.storage.from(PRIVATE_BUCKET).remove(uploadedPaths);
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
    // One path, or several separated by new lines when the message had more than one photo or file.
    if (typeof data === "string" && data) void supabase.storage.from(PRIVATE_BUCKET).remove(data.split("\n"));
    await fetchLatest();
    await onChanged();
  }

  // Opening the editor puts the cursor at the end of the text.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (!editingId) return;
    const field = document.getElementById("messages-edit-field") as HTMLTextAreaElement | null;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, [editingId]);

  function startEdit(message: MessageRow) {
    setEditing({ id: message.id, text: message.body ?? "" });
    setActiveId(null);
  }

  async function saveEdit() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !editing || busy) return;
    setBusy(true); setStatus("");
    const { error } = await supabase.rpc("edit_own_message", { p_message_id: editing.id, p_body: editing.text });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setEditing(null);
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

  // The field grows with what is typed, up to a few lines, and shrinks back after sending.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  function insertEmoji(emoji: string) {
    const el = composerRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? start;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));
    setEmojiOpen(false);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + emoji.length, start + emoji.length); });
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
  const flavour = conversationFlavour(conversation);
  const tone = conversationTone(conversation);
  const flavourLabel = FLAVOUR_LABEL[flavour];
  const headerPhoto = conversation.other_avatar_path ? avatarUrls.get(conversation.other_avatar_path) ?? null : null;
  return <div className={`messages-thread pc-${tone} flavour-${flavour}`}>
    <header className="messages-thread-head">
      <button type="button" className="messages-icon-btn messages-back" onClick={onBack} aria-label="Back to conversations">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>
      </button>
      <ConversationAvatar conversation={conversation} photoUrl={headerPhoto} />
      <div className="messages-thread-title">
        {flavourLabel && <span className="messages-flavour">{flavourLabel}</span>}
        <h2>{channel ? `# ${title}` : title}</h2>
        <span className="messages-topic">
          {[channel ? conversation.topic ?? `${conversation.member_count} people` : conversation.kind === "direct" ? "" : `${conversation.member_count} people`, conversation.muted ? "Muted" : ""].filter(Boolean).join(" · ")}
        </span>
      </div>
      <button type="button" className="messages-icon-btn" onClick={() => setShowMembers(true)} aria-label="Conversation details">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </button>
    </header>

    {conversation.child_thread && <p className="admin-form-status messages-status" role="note">
      {(() => {
        const others = [...people.values()].filter((person) => person.user_id !== userId).map((person) => person.display_name);
        return <>
          {others.length ? `Messages here go to ${joinNames(others)}.` : "No one else is in this conversation right now."}
          {notInPortal.length > 0 && ` ${joinNames(notInPortal)} ${notInPortal.length === 1 ? "is" : "are"} not in the portal yet.`}
        </>;
      })()}
    </p>}

    {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a tap on the empty space closes open message actions; nothing here needs a keyboard */}
    <div className="messages-scroll" ref={listRef} onClick={(event) => { if (event.target === event.currentTarget) { setActiveId(null); } }} onScroll={(event) => {
      const el = event.currentTarget;
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }}>
      {hasMore && <button type="button" className="ghost messages-earlier" onClick={loadEarlier}>Earlier messages</button>}
      {!messages.length && <div className="messages-hello">
        <span className="messages-empty-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z" /></svg></span>
        <p className="portal-empty">Say hello.</p>
      </div>}
      {rows.map(({ message, day, showDay, startsRun, endsRun, card }) => {
        const mine = message.sender_id === userId;
        const sender = message.sender_id ? people.get(message.sender_id) : undefined;
        const group = conversation.kind !== "direct";
        const system = !!message.system_label && !message.deleted_at;
        const [headline, ...rest] = (message.body ?? "").split("\n");
        const own = reactions.filter((r) => r.message_id === message.id);
        const chips = REACTIONS.map((emoji) => ({ emoji, count: own.filter((r) => r.emoji === emoji).length, mine: own.some((r) => r.emoji === emoji && r.user_id === userId) })).filter((chip) => chip.count > 0);
        const open = activeId === message.id;
        const seenInfo = mayWatchReads && !message.deleted_at ? seenCounts.get(message.id) : undefined;
        const senderName = sender?.display_name ?? message.system_label ?? "Former member";
        const personTone = card ? tone : toneFor(message.sender_id);

        const reactionChips = chips.length > 0 && !message.deleted_at && <span className="messages-reactions">
          {chips.map((chip) => <button key={chip.emoji} type="button" className={`messages-chip${chip.mine ? " mine" : ""}`} onClick={() => void react(message.id, chip.emoji)}
            aria-label={`${chip.emoji} ${chip.count}${chip.mine ? ", you reacted" : ""}`} aria-pressed={chip.mine}><span aria-hidden="true">{chip.emoji}</span>{chip.count}</button>)}
        </span>;

        // The small line under a message: its time, and when the message is tapped (or focused), what can be done with it.
        const meta = (showTime: boolean) => <div className={`messages-tools${open ? " open" : ""}`}>
          {!message.deleted_at && !archivedBlock && <span className="messages-picker" role="group" aria-label="React to this message">
            {REACTIONS.map((emoji) => {
              const mineNow = own.some((r) => r.emoji === emoji && r.user_id === userId);
              return <button key={emoji} type="button" className={mineNow ? "mine" : ""} aria-pressed={mineNow} onClick={() => void react(message.id, emoji)} aria-label={`React ${emoji}`}>{emoji}</button>;
            })}
          </span>}
          <span className={`messages-meta${open ? " open" : ""}${showTime ? " timed" : ""}`}>
            {(showTime || open) && <time dateTime={message.created_at}>{shortTime(message.created_at)}</time>}
            {message.edited_at && !message.deleted_at && <span className="messages-edited">Edited</span>}
            {seenInfo && open && !card && <button type="button" className="messages-seen" onClick={() => void openSeen(message.id)}>Seen by {seenInfo.seen} of {seenInfo.total}</button>}
            {!message.deleted_at && <span className="messages-actions">
              {!blocked && <button type="button" onClick={() => { setReplyingTo(message); setActiveId(null); composerRef.current?.focus(); }}>Reply</button>}
              {chips.length > 0 && <button type="button" onClick={() => setReactionsFor(message.id)}>Who reacted</button>}
              {mine && !archivedBlock && canEditMessage(message) && <button type="button" onClick={() => startEdit(message)}>Edit</button>}
              {mine && <button type="button" onClick={() => removeOwn(message)}>Remove</button>}
              {!mine && !message.system_label && <button type="button" onClick={() => { setReporting(message); setReason(""); }}>Report</button>}
            </span>}
          </span>
        </div>;

        // Tapping the message itself (not a link or button inside it) shows or hides its actions.
        const toggle = (event: React.MouseEvent) => {
          if ((event.target as HTMLElement).closest("a,button")) return;
          if (window.getSelection()?.toString()) return;
          setActiveId(activeId === message.id ? null : message.id);
        };

        const quote = !message.deleted_at && message.reply_to && message.reply && <a className="messages-quote" href={`#msg-${message.reply.id}`}>
          <b>{message.reply.sender_id === userId ? "You" : people.get(message.reply.sender_id ?? "")?.display_name ?? "Former member"}</b>
          <span>{snippet(message.reply)}</span>
        </a>;
        // Photos and files on this message. Older messages carry one photo in image_path and no attachment rows.
        const sentAttachments = message.has_attachments ? attachments.get(message.id) : undefined;
        const media: Attachment[] = sentAttachments ?? (message.image_path && !message.has_attachments
          ? [{ id: message.id, message_id: message.id, position: 0, kind: "image", path: message.image_path, name: "Photo", mime: "image/jpeg", size_bytes: 0 }] : []);
        const mediaImages = media.filter((a) => a.kind === "image");
        const mediaFiles = media.filter((a) => a.kind === "file");
        const viewUrls = mediaImages.map((a) => imageUrls.get(a.path)).filter((u): u is string => !!u);
        const hiddenImages = Math.max(0, mediaImages.length - 4);
        const photo = !message.deleted_at && <>
          {mediaImages.length > 0 && <div className={`messages-media count-${Math.min(mediaImages.length, 4)}`}>
            {mediaImages.slice(0, 4).map((a, index) => {
              const url = imageUrls.get(a.path);
              return url
                ? <button key={a.id} type="button" className="messages-photo" onClick={() => setViewing({ urls: viewUrls, index: viewUrls.indexOf(url) })}
                    aria-label={mediaImages.length > 1 ? `Open photo ${index + 1} of ${mediaImages.length}` : "Open photo"}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a signed link to private storage; next/image can't optimize it */}
                    <img src={url} alt="Attachment" loading="lazy" />
                    {index === 3 && hiddenImages > 0 && <span className="messages-more">+{hiddenImages}</span>}
                  </button>
                : <span key={a.id} className="messages-photo-loading">Loading photo…</span>;
            })}
          </div>}
          {mediaFiles.length > 0 && <div className="messages-files">
            {mediaFiles.map((a) => {
              const url = imageUrls.get(a.path);
              const inner = <>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>
                <span className="messages-file-text"><b>{a.name}</b><small>{formatBytes(a.size_bytes)}</small></span>
              </>;
              return url
                ? <a key={a.id} className="messages-file" href={url} target="_blank" rel="noopener noreferrer" download={a.name}>{inner}</a>
                : <span key={a.id} className="messages-file">{inner}</span>;
            })}
          </div>}
          {message.has_attachments && !sentAttachments && <span className="messages-photo-loading">Loading…</span>}
        </>;

        if (card) {
          return <div key={message.id} id={`msg-${message.id}`} className="messages-msg">
            {showDay && <div className="messages-day"><span>{day}</span></div>}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- tapping is a convenience; the same buttons are reachable by keyboard */}
            <article className={`messages-card pc-${personTone}${system ? " is-system" : " is-news"}`} onClick={toggle}>
              <header>
                <span className="messages-announce-tag">{system ? message.system_label : "News"}</span>
                <time dateTime={message.created_at}>{shortTime(message.created_at)}</time>
              </header>
              <h3>{headline}</h3>
              {photo}
              {quote}
              {system
                ? rest.map((line, index) => line && <p key={index}>{line}</p>)
                : rest.length > 0 && <p>{rest.join("\n")}</p>}
              <div className="messages-card-foot">
                {system
                  ? (message.link_path ? <a className="messages-announce-link" href={message.link_path}>Open in review<span aria-hidden="true"> →</span></a> : <span />)
                  : <a className="messages-announce-link" href="/family-village/news">Read in News<span aria-hidden="true"> →</span></a>}
                {!system && sender && <span className="messages-card-by">Posted by {sender.display_name}</span>}
                {seenInfo && <button type="button" className="messages-seen-link" onClick={() => void openSeen(message.id)}>Seen by {seenInfo.seen} of {seenInfo.total}</button>}
                {reactionChips}
              </div>
              {meta(false)}
            </article>
          </div>;
        }

        const showName = !mine && group && startsRun;
        const showAvatar = group && !mine;
        const hasMedia = media.length > 0 && !message.deleted_at;
        return <div key={message.id} id={`msg-${message.id}`} className="messages-msg">
          {showDay && <div className="messages-day"><span>{day}</span></div>}
          <div className={`messages-bubble-row pc-${personTone}${mine ? " mine" : ""}${startsRun ? " run-start" : ""}${endsRun ? " run-end" : ""}${chips.length ? " has-reactions" : ""}${showAvatar ? " with-avatar" : ""}`}>
            {showName && <span className="messages-sender">
              {senderName}
              {sender?.is_teacher && <i>Teacher</i>}{sender?.is_admin && <i>Admin</i>}
            </span>}
            <div className="messages-line">
              {showAvatar && (endsRun
                ? <Avatar url={sender?.avatar_path ? avatarUrls.get(sender.avatar_path) ?? null : null} label={senderName} size="sm" tone={personTone} ring={roleRing(sender)} />
                : <span className="messages-avatar-gap" aria-hidden="true" />)}
              {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- tapping is a convenience; the same buttons are reachable by keyboard */}
              <div className={`messages-bubble${mine ? " mine" : ""}${message.deleted_at ? " removed" : ""}${hasMedia ? " has-photo" : ""}${hasMedia && mediaFiles.length === 0 && !message.body && !message.reply ? " photo-only" : ""}${open ? " open" : ""}`} onClick={toggle}>
                {message.deleted_at
                  ? <em>Message removed</em>
                  : <>
                      {photo}
                      {quote}
                      {editing?.id === message.id
                        ? <div className="messages-edit">
                            <textarea value={editing.text} rows={2} maxLength={4000} id="messages-edit-field" aria-label="Edit your message" disabled={busy}
                              onChange={(event) => setEditing({ id: message.id, text: event.target.value })}
                              onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); }} />
                            <span className="messages-edit-actions">
                              <button type="button" className="ghost" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
                              <button type="button" onClick={() => void saveEdit()} disabled={busy || (!editing.text.trim() && !message.image_path && !message.has_attachments)}>Save</button>
                            </span>
                          </div>
                        : message.body && <p>{splitMentions(message.body, mentionNames).map((part, index) => part.mention
                            ? <span key={index} className={`messages-mention${part.text === `@${myName}` ? " me" : ""}`}>{part.text}</span>
                            : part.text)}</p>}
                    </>}
                {reactionChips}
              </div>
            </div>
            {meta(endsRun || !!message.edited_at)}
          </div>
        </div>;
      })}
    </div>

    {status && <p className="admin-form-status messages-status" role="status">{status}</p>}

    {pending.length > 0 && <ul className="messages-pending" aria-label="Ready to send">
      {pending.map((item) => <li key={item.id} className={item.kind === "image" ? "is-photo" : "is-file"}>
        {item.previewUrl
          // eslint-disable-next-line @next/next/no-img-element -- a local preview of the chosen file
          ? <img src={item.previewUrl} alt="" />
          : <span className="messages-pending-file"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg><b>{item.file.name}</b><small>{formatBytes(item.file.size)}</small></span>}
        <button type="button" className="messages-pending-x" onClick={() => removePending(item.id)} aria-label={`Remove ${item.file.name}`}>×</button>
      </li>)}
    </ul>}

    {replyingTo && !blocked && <div className="messages-replying">
      <span>Replying to <b>{replyingTo.sender_id === userId ? "yourself" : people.get(replyingTo.sender_id ?? "")?.display_name ?? "Former member"}</b>: {snippet(replyingTo, 60)}</span>
      <button type="button" className="messages-icon-btn" onClick={() => setReplyingTo(null)} aria-label="Cancel reply">×</button>
    </div>}

    {mentionQuery !== null && !blocked && mentionMatches.length > 0 && <ul className="messages-suggest" role="listbox" aria-label="Mention someone">
      {mentionMatches.map((person) => <li key={person.user_id}>
        <button type="button" role="option" aria-selected="false" onClick={() => chooseMention(person)}>
          <Avatar url={person.avatar_path ? avatarUrls.get(person.avatar_path) ?? null : null} label={person.display_name} size="sm" tone={toneFor(person.user_id)} ring={roleRing(person)} />
          <span>{person.display_name}</span>{person.is_teacher && <i>Teacher</i>}{person.is_admin && <i>Admin</i>}
        </button>
      </li>)}
    </ul>}

    {emojiOpen && !blocked && <div className="messages-emoji-panel" role="group" aria-label="Insert an emoji">
      <div className="messages-emoji-tabs" role="tablist">
        {EMOJI_GROUPS.map((group) => <button key={group.id} type="button" role="tab" aria-selected={emojiGroup === group.id} aria-label={group.label} className={emojiGroup === group.id ? "active" : ""} onClick={() => setEmojiGroup(group.id)}>{group.icon}</button>)}
      </div>
      <div className="messages-emoji-grid">
        {(EMOJI_GROUPS.find((group) => group.id === emojiGroup) ?? EMOJI_GROUPS[0]).emoji.map((emoji) => <button key={emoji} type="button" onClick={() => insertEmoji(emoji)} aria-label={`Insert ${emoji}`}>{emoji}</button>)}
      </div>
    </div>}

    {blocked ? <p className="messages-readonly" role="note">{blocked}</p> : <form className="messages-composer" onSubmit={(event) => { event.preventDefault(); setEmojiOpen(false); void send(); }}>
      <input ref={fileRef} type="file" accept={ATTACH_ACCEPT} multiple hidden onChange={(event) => chooseFiles(event.target.files)} />
      <button type="button" className="messages-icon-btn messages-attach-button" onClick={() => fileRef.current?.click()} disabled={busy || pending.length >= ATTACH_MAX} aria-label="Add photos or files">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <div className="messages-field">
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
        <button type="button" className="messages-emoji-button" onClick={() => setEmojiOpen(!emojiOpen)} disabled={busy} aria-label="Emoji" aria-expanded={emojiOpen}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M8.5 14.2c.9 1.1 2 1.6 3.5 1.6s2.6-.5 3.5-1.6" /><path d="M9 9.6h.01M15 9.6h.01" strokeWidth="2.6" /></svg>
        </button>
      </div>
      <button type="submit" className="messages-icon-btn send" disabled={busy || (!draft.trim() && !pending.length)} aria-label={busy ? "Sending" : "Send"}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V6M6 11l6-6 6 6" /></svg>
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

    {viewing && <DetailModal title={viewing.urls.length > 1 ? `Photo ${viewing.index + 1} of ${viewing.urls.length}` : "Photo"} onClose={() => setViewing(null)}>
      <div className="messages-lightbox-wrap">
        {viewing.urls.length > 1 && <button type="button" className="messages-icon-btn messages-lightbox-step prev" aria-label="Previous photo"
          onClick={() => setViewing({ ...viewing, index: (viewing.index + viewing.urls.length - 1) % viewing.urls.length })}>‹</button>}
        {/* eslint-disable-next-line @next/next/no-img-element -- a signed link to private storage */}
        <img className="messages-lightbox" src={viewing.urls[viewing.index]} alt="Attachment, full size" />
        {viewing.urls.length > 1 && <button type="button" className="messages-icon-btn messages-lightbox-step next" aria-label="Next photo"
          onClick={() => setViewing({ ...viewing, index: (viewing.index + 1) % viewing.urls.length })}>›</button>}
      </div>
    </DetailModal>}

    {reactionsFor && (() => {
      const list = reactions.filter((r) => r.message_id === reactionsFor);
      return <DetailModal title="Reactions" onClose={() => setReactionsFor(null)}>
        {list.length === 0 && <p className="portal-empty">No reactions.</p>}
        <div className="messages-seen-lists">
          {REACTIONS.filter((emoji) => list.some((r) => r.emoji === emoji)).map((emoji) => {
            const who = list.filter((r) => r.emoji === emoji);
            return <section key={emoji}>
              <h3><span className="messages-reaction-glyph" aria-hidden="true">{emoji}</span> {who.length}</h3>
              <ul className="messages-members">
                {who.map((r) => {
                  const person = people.get(r.user_id);
                  return <li key={r.user_id}>
                    <span className="messages-member"><Avatar url={person?.avatar_path ? avatarUrls.get(person.avatar_path) ?? null : null} label={person?.display_name ?? "?"} size="sm" tone={toneFor(r.user_id)} ring={roleRing(person)} /><span>{r.user_id === userId ? "You" : person?.display_name ?? "Former member"}</span></span>
                  </li>;
                })}
              </ul>
            </section>;
          })}
        </div>
      </DetailModal>;
    })()}

    {seenList && <DetailModal title="Seen by" onClose={() => setSeenList(null)}>
      {!seenList.rows && <p className="portal-empty">Loading…</p>}
      {seenList.rows && <div className="messages-seen-lists">
        {[{ label: "Seen", rows: seenList.rows.filter((row) => row.seen) }, { label: "Not yet", rows: seenList.rows.filter((row) => !row.seen) }].map((group) => <section key={group.label}>
          <h3>{group.label} ({group.rows.length})</h3>
          {group.rows.length === 0 ? <p className="portal-empty">No one.</p> : <ul className="messages-members">
            {group.rows.map((row) => <li key={row.user_id}>
              <span className="messages-member"><Avatar url={row.avatar_path ? avatarUrls.get(row.avatar_path) ?? null : null} label={row.display_name} size="sm" tone={toneFor(row.user_id)} /><span>{row.display_name}</span></span>
            </li>)}
          </ul>}
        </section>)}
      </div>}
      <p className="field-note">Seen means they opened this conversation after it was posted.</p>
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
        {[...people.values()].map((person) => <li key={person.user_id}>
          <Avatar url={person.avatar_path ? avatarUrls.get(person.avatar_path) ?? null : null} label={person.display_name} size="sm" tone={toneFor(person.user_id)} ring={roleRing(person)} />
          <span>{person.display_name}{person.is_teacher && <i>Teacher</i>}{person.is_admin && <i>Admin</i>}</span>
        </li>)}
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
