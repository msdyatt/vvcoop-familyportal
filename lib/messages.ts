export type ConversationKind = "direct" | "group" | "class" | "channel";

export type ConversationRow = {
  id: string; kind: ConversationKind; title: string | null; class_id: string | null;
  last_message_at: string; last_preview: string | null; last_sender_name: string | null;
  unread_count: number; muted: boolean; member_count: number;
  other_user_id: string | null; other_name: string | null; other_avatar_path: string | null;
  topic: string | null; posting: "everyone" | "staff"; audience: "invite" | "everyone" | "class";
  archived_at: string | null; created_by: string | null; system_key: string | null;
};

export type Person = { user_id: string; display_name: string; avatar_path: string | null; is_teacher: boolean; is_admin: boolean };

export type MessageRow = {
  id: string; conversation_id: string; sender_id: string | null;
  body: string | null; image_path: string | null; created_at: string; deleted_at: string | null;
  post_id: string | null; reply_to: string | null;
  /** The message this one answers, embedded by the select below. */
  reply: { id: string; sender_id: string | null; body: string | null; image_path: string | null; deleted_at: string | null } | null;
};

export type Reaction = { message_id: string; user_id: string; emoji: string };

/** The reactions on offer. The same list is enforced in the database. */
export const REACTIONS = ["👍", "❤️", "😂", "🎉", "🙏", "😮"] as const;

export const MESSAGE_COLUMNS = "id,conversation_id,sender_id,body,image_path,created_at,deleted_at,post_id,reply_to,reply:messages!reply_to(id,sender_id,body,image_path,deleted_at)";

export function conversationTitle(c: Pick<ConversationRow, "kind" | "title" | "other_name">): string {
  if (c.kind === "direct") return c.other_name ?? "Conversation";
  return c.title ?? (c.kind === "group" ? "Group" : "Channel");
}

/** Channels and class channels are the shared, named spaces; the rest are private chats. */
export function isChannel(c: Pick<ConversationRow, "kind">): boolean {
  return c.kind === "channel" || c.kind === "class";
}

/** Whether this person may write in the conversation right now, and if not, why. */
export function postingBlock(c: Pick<ConversationRow, "posting" | "archived_at">, roles: string[]): string | null {
  if (c.archived_at) return "This channel is archived, so it is read-only.";
  if (c.posting === "staff" && !roles.includes("admin") && !roles.includes("teacher")) return "Only administrators and teachers post in this channel.";
  return null;
}

/** Whether this person runs the channel: an administrator, or the person who made it. */
export function managesChannel(c: Pick<ConversationRow, "kind" | "created_by">, userId: string, roles: string[]): boolean {
  return c.kind === "channel" && (roles.includes("admin") || c.created_by === userId);
}

/** "2:14 PM" today, "Tue" this week, otherwise "Nov 4". */
export function shortTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 6) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (date.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Splits a message into plain text and @mentions of people in the conversation,
 * longest names first so "@Sam Dyatt" wins over "@Sam".
 */
export function splitMentions(body: string, names: string[]): { text: string; mention: boolean }[] {
  const usable = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!usable.length || !body.includes("@")) return [{ text: body, mention: false }];
  const pattern = new RegExp(`(@(?:${usable.map(escapeRegExp).join("|")}))(?![\\p{L}\\p{N}])`, "u");
  // With one capture group, split() puts every match at an odd index.
  return body.split(pattern).map((text, index) => ({ text, mention: index % 2 === 1 })).filter((part) => part.text !== "");
}

/** A short plain-text stand-in for a message, for reply quotes. */
export function snippet(message: { body: string | null; image_path: string | null; deleted_at: string | null }, max = 80): string {
  if (message.deleted_at) return "Message removed";
  if (message.body) return message.body.length > max ? `${message.body.slice(0, max)}…` : message.body;
  return message.image_path ? "Photo" : "";
}
