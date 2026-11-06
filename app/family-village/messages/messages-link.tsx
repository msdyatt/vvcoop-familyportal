"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";

const POLL_MS = 60_000;

/** The header's link to Messages, with the number of unread messages. */
export default function MessagesLink() {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    async function load() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data } = await supabase.rpc("unread_message_count");
      setUnread(typeof data === "number" ? data : 0);
    }
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return <a className="messages-link" href="/family-village/messages" aria-label={unread ? `Messages, ${unread} unread` : "Messages"}>
    Messages{unread > 0 && <span className="messages-badge">{unread > 99 ? "99+" : unread}</span>}
  </a>;
}
