"use client";

import Avatar from "../avatar";
import { conversationFlavour, conversationTone } from "../../../lib/message-colors";
import { conversationTitle, type ConversationRow } from "../../../lib/messages";

const icon = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/**
 * The picture for a conversation: a person's photo (or initial) for a direct
 * chat, otherwise a rounded tile in the colour of its kind, with a mark that
 * says which kind: # for a channel, a book for a class, two people for a
 * group, a house for a family thread.
 */
export default function ConversationAvatar({ conversation, photoUrl, size = "md" }: {
  conversation: ConversationRow; photoUrl: string | null; size?: "md" | "lg";
}) {
  const flavour = conversationFlavour(conversation);
  const tone = conversationTone(conversation);
  if (flavour === "direct") {
    return <Avatar url={photoUrl} label={conversationTitle(conversation)} size={size} tone={tone} />;
  }
  return <span className={`avatar avatar-${size} avatar-tile pc-${tone}`} aria-hidden="true">
    {flavour === "channel" && <b>#</b>}
    {flavour === "class" && <svg {...icon}><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z" /></svg>}
    {flavour === "family" && <svg {...icon}><path d="M4 11.5 12 5l8 6.5M6 10v9h12v-9M10 19v-5h4v5" /></svg>}
    {flavour === "group" && <svg {...icon}><circle cx="9" cy="9" r="3" /><path d="M3.5 19c.4-3 2.5-4.5 5.5-4.5s5.1 1.5 5.5 4.5M16 6.3a3 3 0 0 1 0 5.4M17.5 14.7c1.7.5 2.8 1.9 3 4.3" /></svg>}
  </span>;
}
