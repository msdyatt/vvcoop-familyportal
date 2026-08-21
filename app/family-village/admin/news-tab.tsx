"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { getSignedFileUrl, uploadPrivateFile } from "../../../lib/storage";

type Post = { id: string; title: string; body: string; audience: string; published_at: string | null; image_storage_path: string | null };

export default function NewsTab({ actorUserId }: { actorUserId: string }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [audience, setAudience] = useState("families");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.from("posts").select("id,title,body,audience,published_at,image_storage_path").order("created_at", { ascending: false }).limit(20);
    if (error) return;
    const rows = (data ?? []) as Post[];
    setPosts(rows);
    const withImages = rows.filter((row) => row.image_storage_path);
    const urls: Record<string, string> = {};
    await Promise.all(withImages.map(async (row) => { const url = await getSignedFileUrl(supabase, row.image_storage_path!); if (url) urls[row.id] = url; }));
    setPreviews(urls);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !title.trim() || !body.trim()) return;
    setBusy(true); setStatus("");
    let imagePath: string | null = null;
    if (file) {
      const result = await uploadPrivateFile(supabase, "news", file);
      if ("error" in result) { setStatus(result.error); setBusy(false); return; }
      imagePath = result.path;
    }
    const { error } = await supabase.from("posts").insert({
      author_user_id: actorUserId, title: title.trim(), body: body.trim(), audience, image_storage_path: imagePath, published_at: new Date().toISOString(),
    });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setTitle(""); setBody(""); setFile(null); setAudience("families");
    setStatus("Published.");
    await load();
  }

  return <section>
    <form className="news-composer" onSubmit={publish}>
      <input required placeholder="Headline" value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
      <textarea required placeholder="What's the news?" value={body} onChange={(event) => setBody(event.target.value)} disabled={busy} />
      <div className="composer-row">
        <select value={audience} onChange={(event) => setAudience(event.target.value)} disabled={busy}>
          <option value="families">Families</option>
          <option value="public">Public website</option>
          <option value="teachers">Teachers only</option>
        </select>
        <label className="file-drop">Photo (optional)<input type="file" accept="image/*" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy} /></label>
      </div>
      <button disabled={busy}>{busy ? "Publishing…" : "Publish news"}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form>
    <div className="news-list">
      {posts.map((post) => <article className="news-item" key={post.id}>
        {previews[post.id] && <img src={previews[post.id]} alt="" />}
        <div><b>{post.title}</b><span>{post.audience} · {post.published_at ? new Date(post.published_at).toLocaleDateString() : "Draft"}</span></div>
      </article>)}
      {!posts.length && <p>No news published yet.</p>}
    </div>
  </section>;
}
