-- RFC 3161 timestamp replies are stored beside the sealed PDF as .tsr files.
-- The private bucket only accepts the file types listed here, so add theirs.
-- Appended, not replaced, so any type added since stays.
update storage.buckets
set allowed_mime_types = array_append(allowed_mime_types, 'application/timestamp-reply')
where id = 'family-village-private'
  and allowed_mime_types is not null
  and not ('application/timestamp-reply' = any (allowed_mime_types));
