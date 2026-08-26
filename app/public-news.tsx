"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../lib/supabase";
import PostAttachments, { usePostAttachments } from "./family-village/post-attachments";
import RichText from "../lib/rich-text";

type PublicPost = { id: string; title: string; body: string; published_at: string | null };

/**
 * News the co-op has chosen to show on its front page.
 *
 * Reads as an unauthenticated visitor, which the `posts_public_read` policy
 * allows for published `public` posts and nothing else. The section removes
 * keeps a small invitation in place when there is nothing to show, so public
 * news remains a real part of the home page instead of appearing only after a
 * first post exists.
 */
export default function PublicNews() {
  const [posts, setPosts] = useState<PublicPost[]>([]);
  const attachments = usePostAttachments(posts.map((post) => post.id));

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data } = await supabase
        .from("posts")
        .select("id,title,body,published_at")
        .eq("audience", "public")
        .not("published_at", "is", null)
        .order("published_at", { ascending: false })
        .limit(4);
      if (!cancelled) setPosts((data ?? []) as PublicPost[]);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  return <section id="news" className="public-news">
    <div className="public-news-heading">
      <p className="eyebrow">From the village</p>
      <h2>Lately at the co-op.</h2>
    </div>
    <div className="public-news-list">
      {posts.map((post) => <article key={post.id}>
        <time dateTime={post.published_at ?? undefined}>
          {post.published_at
            ? new Date(post.published_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
            : ""}
        </time>
        <h3>{post.title}</h3>
        <RichText html={post.body} />
        <PostAttachments attachments={attachments[post.id] ?? []} />
      </article>)}
      {!posts.length && <article className="public-news-empty"><p className="eyebrow">The next story starts here</p><h3>Community news is coming.</h3><p>Updates chosen for public sharing will gather here as the Village grows.</p></article>}
    </div>
  </section>;
}
