"use client";

import DetailModal from "../detail-modal";
import Avatar from "../avatar";
import { ChildDetailsEditor } from "./child-parts";
import type { ChildOverview } from "./use-children";

/** The Edit pop-up on the Children page: photo, "goes by", birthdate and grade, and nothing else. */
export default function ChildEditor({ entry, onClose, onSaved }: {
  entry: ChildOverview;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  return <DetailModal onClose={onClose}>
    <p className="eyebrow">Edit</p>
    <div className="child-detail-heading">
      <Avatar url={entry.avatarUrl} label={entry.child.first_name} size="lg" />
      <h2>{entry.child.first_name} {entry.child.last_name}</h2>
    </div>
    <ChildDetailsEditor child={entry.child} onSaved={onSaved} startEditing onCancel={onClose} />
  </DetailModal>;
}
