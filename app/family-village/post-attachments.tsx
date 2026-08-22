"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import { getSignedFileUrl } from "../../lib/storage";

export type PostAttachment = {
  id: string;
  post_id: string;
  storage_path: string;
  file_name: string | null;
  content_type: string | null;
};

function isImage(attachment: PostAttachment) {
  if (attachment.content_type?.startsWith("image/")) return true;
  // Older rows and anything uploaded without a type still render as photos when
  // the extension says so, rather than falling back to a download link.
  return /\.(png|jpe?g|gif|webp|avif|heic)$/i.test(attachment.storage_path);
}

/**
 * Fetches the attachments for a set of posts in one round trip.
 *
 * Callers hold whole lists of posts, so fetching per post would be a query per
 * row. Returns a map keyed by post id.
 */
export function usePostAttachments(postIds: string[]) {
  const [byPost, setByPost] = useState<Record<string, PostAttachment[]>>({});
  const key = postIds.join(",");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase || !postIds.length) { setByPost({}); return; }
      const { data } = await supabase
        .from("post_attachments")
        .select("id,post_id,storage_path,file_name,content_type")
        .in("post_id", postIds)
        .order("sort_order");
      if (cancelled) return;
      const grouped: Record<string, PostAttachment[]> = {};
      ((data ?? []) as PostAttachment[]).forEach((row) => {
        grouped[row.post_id] = [...(grouped[row.post_id] ?? []), row];
      });
      setByPost(grouped);
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the joined ids; postIds is a fresh array each render
  }, [key]);

  return byPost;
}

/**
 * Everything attached to a post: photos as a grid, other files as links.
 *
 * The bucket is private, so every file needs a signed URL. Those are minted
 * here on mount rather than stored, and they expire on their own.
 */
export default function PostAttachments({ attachments }: { attachments: PostAttachment[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    async function sign() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase || !attachments.length) return;
      const entries = await Promise.all(attachments.map(async (attachment) => {
        const url = await getSignedFileUrl(supabase, attachment.storage_path);
        return [attachment.id, url] as const;
      }));
      if (cancelled) return;
      setUrls(Object.fromEntries(entries.filter(([, url]) => url) as [string, string][]));
    }
    sign();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-signs when the set of attachments changes
  }, [attachments.map((a) => a.id).join(",")]);

  if (!attachments.length) return null;

  const photos = attachments.filter(isImage);
  const files = attachments.filter((attachment) => !isImage(attachment));

  return <div className="post-attachments">
    {photos.length > 0 && <div className="post-photo-grid">
      {photos.map((photo) => urls[photo.id]
        ? <a key={photo.id} href={urls[photo.id]} target="_blank" rel="noreferrer" className="post-photo">
            {/* eslint-disable-next-line @next/next/no-img-element -- signed private-bucket URL; next/image cannot optimise a short-lived remote URL */}
            <img src={urls[photo.id]} alt={photo.file_name ?? ""} loading="lazy" />
          </a>
        : <span key={photo.id} className="post-photo loading" aria-hidden />)}
    </div>}

    {files.length > 0 && <ul className="post-file-list">
      {files.map((file) => <li key={file.id}>
        {urls[file.id]
          ? <a href={urls[file.id]} target="_blank" rel="noreferrer">{file.file_name || "Attachment"} ↗</a>
          : <span>{file.file_name || "Attachment"}</span>}
      </li>)}
    </ul>}
  </div>;
}

/** A single thumbnail for a post in a list, so a photo post reads as one. */
export function PostThumbnail({ attachments }: { attachments: PostAttachment[] }) {
  const first = attachments.find(isImage);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function sign() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase || !first) return;
      const signed = await getSignedFileUrl(supabase, first.storage_path);
      if (!cancelled) setUrl(signed);
    }
    sign();
    return () => { cancelled = true; };
  }, [first]);

  if (!first || !url) return null;
  // eslint-disable-next-line @next/next/no-img-element -- signed private-bucket URL
  return <img className="post-thumb" src={url} alt="" loading="lazy" />;
}
