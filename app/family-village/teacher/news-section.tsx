"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import DetailModal from "../detail-modal";
import PostAttachments, { PostThumbnail, usePostAttachments } from "../post-attachments";

type Post = {
  id: string; title: string; body: string; audience: string;
  class_id: string | null; published_at: string | null;
};

/**
 * News for the teaching team, read-only.
 *
 * Deliberately narrowed to the `teachers` audience and `class` posts for the
 * teacher's own classes. RLS would also return `public` and `families` posts,
 * but a teacher opening the Lounge wants what concerns them teaching, not the
 * whole co-op's noticeboard -- they see that in the family portal already.
 */
export default function NewsSection({ classes }: { classes: { id: string; title: string }[] }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const attachments = usePostAttachments(posts.map((post) => post.id));

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase
      .from("posts")
      .select("id,title,body,audience,class_id,published_at")
      .not("published_at", "is", null)
      .in("audience", ["teachers", "class"])
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
            <PostThumbnail attachments={attachments[post.id] ?? []} />
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
      : <p className="portal-empty">Nothing for the teaching team right now. Co-op-wide news is in your family portal.</p>}

    {open && <DetailModal title={open.title} onClose={() => setOpenId(null)}>
      <p className="portal-empty compliance-note">
        {open.published_at ? new Date(open.published_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : ""}
        {open.audience === "class" ? ` · ${classTitle(open.class_id) ?? "a class"}` : open.audience === "teachers" ? " · teaching team" : ""}
      </p>
      <p className="prose-body">{open.body}</p>
      <PostAttachments attachments={attachments[open.id] ?? []} />
    </DetailModal>}
  </section>;
}
