"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { conversationTitle, managesChannel, type ConversationRow, type Person } from "../../../lib/messages";

type ClassChoice = { id: string; title: string };

/**
 * Everything about one channel in a single sheet: who is in it, and, for the
 * people who run it, its name, description, who may post, the class it
 * follows, and archiving. The server checks every one of these again.
 */
export default function ChannelDetails({ conversation, userId, roles, people, onToggleMute, onChanged, onLeft, onClose }: {
  conversation: ConversationRow; userId: string; roles: string[]; people: Person[]; onToggleMute: () => void | Promise<void>;
  onChanged: () => void | Promise<void>; onLeft: () => void; onClose: () => void;
}) {
  const isAdmin = roles.includes("admin");
  const manager = managesChannel(conversation, userId, roles);
  const builtIn = !!conversation.system_key;
  const archived = !!conversation.archived_at;
  const [title, setTitle] = useState(conversation.title ?? "");
  const [topic, setTopic] = useState(conversation.topic ?? "");
  const [posting, setPosting] = useState<"everyone" | "staff">(conversation.posting);
  const [classes, setClasses] = useState<ClassChoice[]>([]);
  const [classId, setClassId] = useState(conversation.class_id ?? "");
  const [addable, setAddable] = useState<Person[]>([]);
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const inviteOnly = conversation.kind === "channel" && conversation.audience === "invite";

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    (async () => {
      if (isAdmin && conversation.kind === "channel" && !builtIn) {
        const { data } = await supabase.from("classes").select("id,title").eq("active", true).order("title");
        setClasses((data ?? []) as ClassChoice[]);
      }
      if (manager && inviteOnly && !archived) {
        const { data } = await supabase.rpc("messageable_people");
        setAddable((data ?? []) as Person[]);
      }
    })();
  }, [isAdmin, manager, inviteOnly, archived, builtIn, conversation.kind]);

  async function run(label: string, action: () => PromiseLike<{ error: { message: string } | null }>, after?: () => void) {
    setBusy(true); setStatus("");
    const { error } = await action();
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setStatus(label);
    await onChanged();
    after?.();
  }

  const supabase = getSupabaseBrowserClient();
  if (!supabase) return null;
  const memberIds = new Set(people.map((p) => p.user_id));
  const candidates = addable.filter((p) => !memberIds.has(p.user_id));

  return <div className="channel-details portal-form">
    {conversation.topic && !manager && <p>{conversation.topic}</p>}
    {builtIn && <p className="field-note">This is a built-in channel. {conversation.audience === "everyone" ? "Every member is in it automatically." : ""}{conversation.audience === "admins" ? "Only administrators are in it, and they are added and removed automatically. Reports land here; the actual decisions are made on the Messaging tab of the Admin page." : ""}</p>}
    {conversation.kind === "class" && <p className="field-note">This channel follows its class. Its members are the class&rsquo;s teachers and the adults of every enrolled child.</p>}
    {conversation.kind === "channel" && conversation.audience === "class" && <p className="field-note">This channel follows a class, so its members update as enrollment changes.</p>}

    {manager && <section>
      <h3>Details</h3>
      {!builtIn && <label><span className="field-caption">Name</span><input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} /></label>}
      <label><span className="field-caption">Description</span><textarea value={topic} maxLength={200} rows={2} onChange={(e) => setTopic(e.target.value)} /></label>
      {!builtIn && <label><span className="field-caption">Who can post</span>
        <select value={posting} onChange={(e) => setPosting(e.target.value as "everyone" | "staff")}>
          <option value="everyone">Everyone in the channel</option>
          <option value="staff">Only administrators and teachers</option>
        </select>
      </label>}
      <button type="button" disabled={busy || (!builtIn && !title.trim())}
        onClick={() => run("Saved.", () => supabase.rpc("update_channel", { p_id: conversation.id, p_title: title, p_topic: topic, p_posting: posting }))}>Save details</button>
    </section>}

    {isAdmin && conversation.kind === "channel" && !builtIn && <section>
      <h3>Follow a class</h3>
      <p className="field-note">Linked channels hold the class&rsquo;s teachers and enrolled families, and keep up as enrollment changes.</p>
      <label><span className="field-caption">Class</span>
        <select value={classId} onChange={(e) => setClassId(e.target.value)}>
          <option value="">Not linked</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
      </label>
      <button type="button" className="ghost" disabled={busy || classId === (conversation.class_id ?? "")}
        onClick={() => run(classId ? "Linked to the class." : "Unlinked. Current members stay.", () => supabase.rpc("set_channel_class", { p_id: conversation.id, p_class: classId || null }))}>
        {classId ? "Link to this class" : "Unlink"}
      </button>
    </section>}

    <section>
      <h3>{people.length} {people.length === 1 ? "person" : "people"}</h3>
      <ul className="messages-members">
        {people.map((person) => <li key={person.user_id}>
          <span>{person.display_name}{person.is_teacher && <i>Teacher</i>}{person.is_admin && <i>Admin</i>}</span>
          {manager && inviteOnly && person.user_id !== userId && <button type="button" className="ghost" disabled={busy}
            onClick={() => run(`Removed ${person.display_name}.`, () => supabase.rpc("remove_channel_member", { p_id: conversation.id, p_user: person.user_id }))}>Remove</button>}
        </li>)}
      </ul>
    </section>

    {manager && inviteOnly && !archived && <section>
      <h3>Add people</h3>
      {!candidates.length && <p className="field-note">No one else you can add.</p>}
      <ul className="messages-people">
        {candidates.map((person) => <li key={person.user_id}><label className="messages-check">
          <input type="checkbox" checked={adding.has(person.user_id)} onChange={(e) => {
            const next = new Set(adding);
            if (e.target.checked) next.add(person.user_id); else next.delete(person.user_id);
            setAdding(next);
          }} /><span>{person.display_name}</span>
        </label></li>)}
      </ul>
      {adding.size > 0 && <button type="button" disabled={busy}
        onClick={() => run("Added.", () => supabase.rpc("add_channel_members", { p_id: conversation.id, p_members: [...adding] }), () => setAdding(new Set()))}>Add {adding.size}</button>}
    </section>}

    <div className="bar-footer">
      <button type="button" className="ghost" disabled={busy} onClick={() => void onToggleMute()}>{conversation.muted ? "Unmute" : "Mute"}</button>
      {inviteOnly && <button type="button" className="ghost" disabled={busy}
        onClick={() => { if (confirm(`Leave ${conversationTitle(conversation)}?`)) void run("", () => supabase.rpc("leave_conversation", { p_conversation_id: conversation.id }), onLeft); }}>Leave channel</button>}
      {manager && !builtIn && <button type="button" className="ghost" disabled={busy}
        onClick={() => { if (archived || confirm("Archive this channel? It becomes read-only and moves out of the way. Nothing is deleted.")) void run(archived ? "Restored." : "Archived.", () => supabase.rpc("archive_channel", { p_id: conversation.id, p_archived: !archived }), archived ? undefined : onClose); }}>
        {archived ? "Restore channel" : "Archive channel"}</button>}
      <button type="button" onClick={onClose}>Done</button>
    </div>
    {status && <p className="admin-form-status" role="status">{status}</p>}
  </div>;
}
