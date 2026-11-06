"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import type { Person } from "../../../lib/messages";
import DetailModal from "../detail-modal";

type ClassChoice = { id: string; title: string };
type Tab = "direct" | "group" | "class";

export default function NewConversation({ roles, userId, onOpen, onClose }: {
  roles: string[]; userId: string; onOpen: (conversationId: string) => void; onClose: () => void;
}) {
  const canLead = roles.includes("teacher") || roles.includes("admin");
  const [tab, setTab] = useState<Tab>("direct");
  const [people, setPeople] = useState<Person[]>([]);
  const [classes, setClasses] = useState<ClassChoice[]>([]);
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    (async () => {
      const { data } = await supabase.rpc("messageable_people");
      setPeople((data ?? []) as Person[]);
      if (canLead) {
        const rows = roles.includes("admin")
          ? (await supabase.from("classes").select("id,title").eq("active", true).order("title")).data
          : (await supabase.from("teacher_assignments").select("classes(id,title)").eq("user_id", userId)).data?.map((row) => (row as unknown as { classes: ClassChoice | null }).classes);
        setClasses(((rows ?? []) as (ClassChoice | null)[]).filter((row): row is ClassChoice => !!row));
      }
      setLoaded(true);
    })();
  }, [canLead, roles, userId]);

  async function run(action: () => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
    setBusy(true); setStatus("");
    const { data, error } = await action();
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    onOpen(String(data));
  }

  const supabase = getSupabaseBrowserClient();
  const needle = search.trim().toLowerCase();
  const shown = people.filter((person) => !needle || person.display_name.toLowerCase().includes(needle));
  const label = (person: Person) => person.is_admin ? "Administrator" : person.is_teacher ? "Teacher" : "";

  return <DetailModal title="New message" onClose={onClose}>
    <div className="portal-form messages-new">
      {canLead && <div className="messages-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "direct"} className={tab === "direct" ? "active" : ""} onClick={() => setTab("direct")}>One person</button>
        <button type="button" role="tab" aria-selected={tab === "group"} className={tab === "group" ? "active" : ""} onClick={() => setTab("group")}>New group</button>
        <button type="button" role="tab" aria-selected={tab === "class"} className={tab === "class" ? "active" : ""} onClick={() => setTab("class")}>Class channel</button>
      </div>}

      {tab !== "class" && <label><span className="field-caption">Find someone</span>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name" autoComplete="off" />
      </label>}

      {tab === "group" && <label><span className="field-caption">Group name</span>
        <input value={groupName} onChange={(event) => setGroupName(event.target.value)} maxLength={80} placeholder="Field trip drivers" />
      </label>}

      {tab === "direct" && <ul className="messages-people">
        {shown.map((person) => <li key={person.user_id}>
          <button type="button" disabled={busy} onClick={() => supabase && run(() => supabase.rpc("start_direct_conversation", { p_other: person.user_id }))}>
            <span>{person.display_name}</span>{label(person) && <i>{label(person)}</i>}
          </button>
        </li>)}
      </ul>}

      {tab === "group" && <ul className="messages-people">
        {shown.map((person) => <li key={person.user_id}>
          <label className="messages-check">
            <input type="checkbox" checked={chosen.has(person.user_id)} onChange={(event) => {
              const next = new Set(chosen);
              if (event.target.checked) next.add(person.user_id); else next.delete(person.user_id);
              setChosen(next);
            }} />
            <span>{person.display_name}</span>{label(person) && <i>{label(person)}</i>}
          </label>
        </li>)}
      </ul>}

      {tab === "class" && <>
        <p className="portal-empty">A class channel holds the class&rsquo;s teachers and the adults of every enrolled child. It updates itself as enrollment changes.</p>
        <ul className="messages-people">
          {classes.map((row) => <li key={row.id}>
            <button type="button" disabled={busy} onClick={() => supabase && run(() => supabase.rpc("open_class_conversation", { p_class_id: row.id }))}><span>{row.title}</span></button>
          </li>)}
          {loaded && !classes.length && <li className="portal-empty">No classes to open.</li>}
        </ul>
      </>}

      {loaded && tab !== "class" && !shown.length && <p className="portal-empty">{people.length ? "No one matches that search." : "There is no one you can message yet."}</p>}

      {tab === "group" && <div className="row-actions">
        <button type="button" disabled={busy || !groupName.trim() || !chosen.size}
          onClick={() => supabase && run(() => supabase.rpc("create_group_conversation", { p_title: groupName, p_members: [...chosen] }))}>
          {busy ? "Creating…" : `Create group${chosen.size ? ` (${chosen.size})` : ""}`}
        </button>
      </div>}

      {status && <p className="admin-form-status" role="status">{status}</p>}
    </div>
  </DetailModal>;
}
