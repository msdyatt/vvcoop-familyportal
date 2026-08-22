"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { uploadPrivateFile } from "../../../lib/storage";
import { PostThumbnail, usePostAttachments } from "../post-attachments";

type Post = { id: string; title: string; body: string; audience: string; class_id: string | null; published_at: string | null };

type ClassOption = { id: string; title: string };

export default function NewsTab({ actorUserId }: { actorUserId: string }) {
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [classId, setClassId] = useState("");
  const [posts, setPosts] = useState<Post[]>([]);
  const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [audience, setAudience] = useState("families");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState("");
  const attachments = usePostAttachments(posts.map((post) => post.id));

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data, error }, { data: classRows }] = await Promise.all([
      supabase.from("posts").select("id,title,body,audience,class_id,published_at").order("created_at", { ascending: false }).limit(20),
      supabase.from("classes").select("id,title").order("title"),
    ]);
    if (error) return;
    setPosts((data ?? []) as Post[]);
    setClasses((classRows ?? []) as ClassOption[]);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  async function removePost(id: string, headline: string) {
    if (!confirm(`Delete "${headline}"? Families and teachers will no longer see it, and its photos go with it. This cannot be undone.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    // post_attachments cascades on the foreign key, so the files go too.
    const { error } = await supabase.from("posts").delete().eq("id", id);
    if (error) { setStatus(error.message); return; }
    setStatus(`Deleted "${headline}".`);
    await load();
  }

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !title.trim() || !body.trim()) return;
    if (audience === "class" && !classId) { setStatus("Choose which class this is for."); return; }
    setBusy(true); setStatus("");

    // Upload first. A post that exists with half its photos missing is worse
    // than one that was never published, so nothing is inserted until every
    // file is safely in the bucket.
    const uploaded: { path: string; file: File }[] = [];
    for (const file of files) {
      const result = await uploadPrivateFile(supabase, "news", file);
      if ("error" in result) { setStatus(`${file.name}: ${result.error}`); setBusy(false); return; }
      uploaded.push({ path: result.path, file });
    }

    const { data: post, error } = await supabase.from("posts").insert({
      author_user_id: actorUserId, title: title.trim(), body: body.trim(), audience,
      class_id: audience === "class" ? classId || null : null,
      published_at: new Date().toISOString(),
    }).select("id").single();
    if (error) { setStatus(error.message); setBusy(false); return; }

    if (uploaded.length) {
      const { error: attachError } = await supabase.from("post_attachments").insert(
        uploaded.map((item, index) => ({
          post_id: post.id, storage_path: item.path,
          file_name: item.file.name, content_type: item.file.type || null, sort_order: index,
        })),
      );
      if (attachError) { setStatus(`Published, but the files could not be attached: ${attachError.message}`); setBusy(false); await load(); return; }
    }

    setBusy(false);
    setTitle(""); setBody(""); setFiles([]); setAudience("families");
    setStatus(uploaded.length ? `Published with ${uploaded.length} file${uploaded.length === 1 ? "" : "s"}.` : "Published.");
    await load();
  }

  return <section>
    <form className="news-composer" onSubmit={publish}>
      <input required placeholder="Headline" value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} />
      <textarea required placeholder="What's the news?" value={body} onChange={(event) => setBody(event.target.value)} disabled={busy} />
      <div className="composer-row">
        <select value={audience} onChange={(event) => setAudience(event.target.value)} disabled={busy}>
          <option value="families">Every family</option>
          <option value="teachers">Teaching team only</option>
          <option value="class">One class</option>
          <option value="public">Front page</option>
        </select>
        {audience === "class" && <select value={classId} onChange={(event) => setClassId(event.target.value)} disabled={busy}>
          <option value="">Choose a class…</option>
          {classes.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}
        </select>}
        <label className="file-drop"><span className="field-caption">Photos or files <i>optional</i></span>
          <input type="file" multiple onChange={(event) => setFiles([...(event.target.files ?? [])])} disabled={busy} />
        </label>
      </div>
      <p className="composer-hint">{
        audience === "public" ? "Shown on the co-op's front page. That page is currently behind the shared site password, so this reaches people you have given the password to — not the open web."
        : audience === "teachers" ? "Shown in the Teacher's Lounge only. Families never see it, including parents who also teach."
        : audience === "class" ? "Shown to that class's teacher and to the families with a child in it."
        : "Shown on every family's dashboard."
      }</p>
      {files.length > 0 && <p className="composer-files">{files.length} file{files.length === 1 ? "" : "s"} ready: {files.map((file) => file.name).join(", ")}</p>}
      <button disabled={busy}>{busy ? "Publishing…" : "Publish news"}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form>
    <div className="news-list">
      {posts.map((post) => <article className="news-item" key={post.id}>
        <PostThumbnail attachments={attachments[post.id] ?? []} />
        <div>
          <b>{post.title}</b>
          <span>
            {post.audience} · {post.published_at ? new Date(post.published_at).toLocaleDateString() : "Draft"}
            {(attachments[post.id]?.length ?? 0) > 0 ? ` · ${attachments[post.id].length} file${attachments[post.id].length === 1 ? "" : "s"}` : ""}
          </span>
        </div>
        <div className="row-actions"><button className="danger" onClick={() => removePost(post.id, post.title)}>Delete</button></div>
      </article>)}
      {!posts.length && <p>No news published yet.</p>}
    </div>
  </section>;
}
