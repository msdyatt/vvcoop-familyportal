-- QA finding VV-12: the private bucket had no file-size or MIME-type
-- constraint at all, and every upload call site (lib/storage.ts's shared
-- uploadPrivateFile()) only ever trusts the browser's own File object --
-- nothing server-side validated what actually got accepted.
--
-- Bucket-level limits are enforced by Storage itself, so this holds
-- regardless of what any client claims. allowed_mime_types is necessarily
-- bucket-wide, not per-folder (avatars/news/rich-text images, compliance
-- PDFs, and teacher handouts of any common document type all share this one
-- bucket) -- narrowed to the types this app's own upload inputs actually
-- accept, rather than every MIME type in existence, but still one shared
-- list rather than a true per-folder allowlist. A tighter per-folder check
-- (plus real magic-byte sniffing instead of a declared Content-Type) would
-- need a signed-upload edge function in front of every one of the ~8 upload
-- call sites -- a bigger, separate piece of work, not attempted here.
update storage.buckets
set file_size_limit = 20971520, -- 20 MiB
    allowed_mime_types = array[
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'application/pdf',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv'
    ]
where id = 'family-village-private';
