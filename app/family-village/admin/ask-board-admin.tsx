"use client";

import type { ReactNode } from "react";
import { PERMISSION_LABELS, type AdminPermission } from "../../../lib/admin-access";

/**
 * Shown in place of (or next to) a control the person may not use. The database
 * refuses the action either way; this says why and who to ask.
 */
export default function AskBoardAdmin({ permission, children }: { permission: AdminPermission; children?: ReactNode }) {
  return <p className="ask-board-admin" role="note">
    <b>Ask a board admin.</b> {children ?? <>This needs the &ldquo;{PERMISSION_LABELS[permission]}&rdquo; permission.</>}
  </p>;
}
