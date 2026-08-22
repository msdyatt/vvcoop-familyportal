"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import DetailModal from "../detail-modal";

type Post = {
  id: string; title: string; body: string; audience: string;
  class_id: string | null; published_at: string | null;
};

/**
 * Village news, read-only.
 *
 * Administrators could already publish to a `teachers` audience but the Lounge
 * had nowhere to show it, so those posts were written and never seen. No policy
 * change was needed: posts_read already narrows a teacher to the `teachers`
 * audience plus `class` posts for classes they teach, so this query returns
 * exactly what they are entitled to without filtering here.
 */
export default function NewsSection({ classes }: { classes: { id: string; title: string }[] }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase
      .from("posts")
      .select("id,title,body,audience,class_id,published_at")
      .not("published_at", "is", null)
      .order("published_at", { ascending: false })
      .limit(20);
    setPosts((data ?? []) as Post[]);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  const open = posts.find((post) => post.id === openId) ?? null;
  const classTitle = (id: string | null) => classes.find((row) => row.id === id)?.title;

  return <section id="news">
    <p className="card-kicker">Village news</p>
    <h2>What the Village is saying.</h2>

    {loading ? <p className="portal-empty">Loading news…</p>
      : posts.length ? <ol className="portal-list clickable-list">
        {posts.map((post) => <li key={post.id}>
          <div role="button" tabIndex={0}
            onClick={() => setOpenId(post.id)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpenId(post.id); } }}
            style={{ display: "contents" }}>
            <div>
              <b>{post.title}</b>
              <span>
                {post.published_at ? new Date(post.published_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : ""}
                {post.audience === "class" ? ` · ${classTitle(post.class_id) ?? "a class"}` : post.audience === "teachers" ? " · teaching team" : ""}
              </span>
            </div>
          </div>
        </li>)}
      </ol>
      : <p className="portal-empty">No news has been published yet.</p>}

    {open && <DetailModal title={open.title} onClose={() => setOpenId(null)}>
      <p className="portal-empty compliance-note">
        {open.published_at ? new Date(open.published_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : ""}
        {open.audience === "class" ? ` · ${classTitle(open.class_id) ?? "a class"}` : open.audience === "teachers" ? " · teaching team" : ""}
      </p>
      <p className="prose-body">{open.body}</p>
    </DetailModal>}
  </section>;
}
