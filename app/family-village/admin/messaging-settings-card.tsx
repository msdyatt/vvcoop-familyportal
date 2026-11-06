"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";

const OPTIONS = [
  { value: "admins", label: "Administrators only", note: "Teachers and parents can still start group chats and direct messages." },
  { value: "staff", label: "Administrators and teachers", note: "Teachers can create channels, including one for their own class." },
  { value: "members", label: "Any member", note: "Anyone can create an invite-only channel. Channels for everyone stay with administrators." },
] as const;

/** Who may create channels. Everything else about channels is decided per channel. */
export default function MessagingSettingsCard() {
  const [value, setValue] = useState<string>("admins");
  const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("messaging_settings").select("channel_creators").maybeSingle();
    if (data?.channel_creators) setValue(data.channel_creators);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { void load(); }, []);

  async function choose(next: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const previous = value;
    setValue(next);
    const { error } = await supabase.rpc("set_channel_creators", { p_value: next });
    if (error) { setValue(previous); setStatus(error.message); return; }
    setStatus("Saved.");
  }

  return <article className="integration-card">
    <div className="integration-card-head"><h3>Who can create channels</h3></div>
    <p className="field-note">Class channels, and the built-in Announcements and General channels, always exist. This decides who can add others.</p>
    <fieldset className="messaging-creators">
      <legend className="sr-only">Who can create channels</legend>
      {OPTIONS.map((option) => <label key={option.value} className="messaging-creator-option">
        <input type="radio" name="channel-creators" checked={value === option.value} onChange={() => void choose(option.value)} />
        <span><b>{option.label}</b><small>{option.note}</small></span>
      </label>)}
    </fieldset>
    {status && <p className="admin-form-status" role="status">{status}</p>}
  </article>;
}
