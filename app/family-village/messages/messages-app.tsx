"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import LoadingScreen from "../loading-screen";
import { getSignedFileUrls } from "../../../lib/storage";
import { usePortalAccess } from "../../../lib/use-portal-access";
import { useBackLayer } from "../../../lib/use-back-layer";
import { conversationTitle, isChannel, shortTime, type ConversationRow } from "../../../lib/messages";
import AppHeader from "../app-header";
import Avatar from "../avatar";
import MfaChallengeScreen from "../mfa-challenge";
import Thread from "./thread";
import NewConversation from "./new-conversation";

const POLL_MS = 30_000;

export default function MessagesApp() {
  const { state: access, userId, roles, recheck } = usePortalAccess("member");
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [avatarUrls, setAvatarUrls] = useState<Map<string, string>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [canCreateChannel, setCanCreateChannel] = useState(false);
  // Bumped whenever something may have changed (a live event, or the slow poll),
  // so the open thread knows to look again.
  const [tick, setTick] = useState(0);

  const loadConversations = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.rpc("my_conversations");
    const rows = (data ?? []) as ConversationRow[];
    setConversations(rows);
    setLoaded(true);
    const paths = rows.map((row) => row.other_avatar_path).filter((path): path is string => !!path);
    if (paths.length) setAvatarUrls(await getSignedFileUrls(supabase, paths));
  }, []);

  function select(id: string | null) {
    setSelectedId(id);
  }

  // Back (button or swipe) returns from a conversation to the list.
  useBackLayer(selectedId !== null, () => setSelectedId(null));

  useEffect(() => {
    if (access !== "ready") return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const fromLink = new URLSearchParams(window.location.search).get("c");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the link once the page is ready
    if (fromLink) setSelectedId(fromLink);
    void loadConversations();
    void supabase.rpc("can_create_channels").then(({ data }) => setCanCreateChannel(data === true));

    // Live updates. Row-level security decides which messages this person is
    // sent, so the channel can listen to the whole table safely.
    const channel = supabase.channel("messages-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => {
        setTick((n) => n + 1);
        void loadConversations();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "message_reactions" }, () => setTick((n) => n + 1))
      .subscribe();
    // The poll is the safety net for a dropped connection.
    const timer = setInterval(() => { setTick((n) => n + 1); void loadConversations(); }, POLL_MS);
    return () => { clearInterval(timer); void supabase.removeChannel(channel); };
  }, [access, loadConversations]);

  async function signOutToEntry() {
    await getSupabaseBrowserClient()?.auth.signOut();
    window.location.assign("/family-village");
  }

  if (access === "loading") return <LoadingScreen />;
  if (access === "mfa-challenge") return <MfaChallengeScreen onVerified={recheck} onCancel={signOutToEntry} />;
  if (access === "denied") return <main className="portal-state"><p className="eyebrow">Private family portal</p><h1>Please sign in.</h1><a href="/family-village">Return to sign in →</a></main>;

  const selected = conversations.find((row) => row.id === selectedId) ?? null;

  function renderRow(row: ConversationRow) {
    const title = conversationTitle(row);
    const channel = isChannel(row);
    return <li key={row.id}>
      <button type="button" className={`messages-row${row.id === selectedId ? " active" : ""}`} onClick={() => select(row.id)}>
        {channel
          ? <span className="avatar avatar-md avatar-channel" aria-hidden="true">#</span>
          : <Avatar url={row.other_avatar_path ? avatarUrls.get(row.other_avatar_path) ?? null : null} label={title.slice(0, 1).toUpperCase()} size="md" />}
        <span className="messages-row-text">
          <span className="messages-row-top"><b>{title}</b><time>{shortTime(row.last_message_at)}</time></span>
          <span className="messages-row-preview">
            {row.last_preview ? `${row.kind !== "direct" && row.last_sender_name ? `${row.last_sender_name}: ` : ""}${row.last_preview}` : row.topic ?? "No messages yet"}
          </span>
        </span>
        {row.unread_count > 0 && !row.muted && !row.archived_at && <span className="messages-badge" aria-label={`${row.unread_count} unread`}>{row.unread_count}</span>}
      </button>
    </li>;
  }

  // Built-in channels first, then the rest by recent activity.
  const byPin = (a: ConversationRow, b: ConversationRow) => Number(!!b.system_key) - Number(!!a.system_key);
  const live = conversations.filter((row) => !row.archived_at);
  const sections = [
    { key: "channels", label: "Channels", rows: live.filter(isChannel).sort(byPin) },
    { key: "chats", label: "Messages", rows: live.filter((row) => !isChannel(row)) },
    { key: "archived", label: "Archived", rows: conversations.filter((row) => !!row.archived_at) },
  ];

  return <main className="workspace-preview messages-page">
    <AppHeader current="home" roles={roles} title="Messages" subtitle="Talk with teachers and other families." />
    <div className="messages-shell" data-view={selected ? "thread" : "list"}>
      <aside className="messages-list" aria-label="Conversations">
        <div className="messages-list-head">
          <b>Conversations</b>
          <button type="button" onClick={() => setCreating(true)}>New</button>
        </div>
        {!loaded && <p className="portal-empty">Loading…</p>}
        {loaded && !conversations.length && <p className="portal-empty">Nothing here yet. Choose New to message a teacher or another family.</p>}
        {sections.map((section) => section.rows.length > 0 && <div key={section.key} className="messages-section">
          {section.key === "archived"
            ? <details>
                <summary>{section.label} ({section.rows.length})</summary>
                <ul>{section.rows.map(renderRow)}</ul>
              </details>
            : <>
                <p className="messages-section-title">{section.label}</p>
                <ul>{section.rows.map(renderRow)}</ul>
              </>}
        </div>)}
      </aside>

      <section className="messages-thread-pane">
        {selected
          ? <Thread key={selected.id} conversation={selected} userId={userId} roles={roles} tick={tick} onBack={() => select(null)} onChanged={loadConversations} />
          : <div className="messages-empty"><p className="portal-empty">Select a conversation, or start a new one.</p></div>}
      </section>
    </div>

    {/* Android's main action, as an extended floating button (hidden elsewhere by CSS). */}
    <button type="button" className="messages-fab" onClick={() => setCreating(true)}>+ New message</button>

    {creating && <NewConversation roles={roles} userId={userId} canCreateChannel={canCreateChannel} onClose={() => setCreating(false)}
      onOpen={(id) => { setCreating(false); void loadConversations(); select(id); }} />}
  </main>;
}
