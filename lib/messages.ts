export type ConversationKind = "direct" | "group" | "class";

export type ConversationRow = {
  id: string; kind: ConversationKind; title: string | null; class_id: string | null;
  last_message_at: string; last_preview: string | null; last_sender_name: string | null;
  unread_count: number; muted: boolean; member_count: number;
  other_user_id: string | null; other_name: string | null; other_avatar_path: string | null;
};

export type Person = { user_id: string; display_name: string; avatar_path: string | null; is_teacher: boolean; is_admin: boolean };

export type MessageRow = {
  id: string; conversation_id: string; sender_id: string | null;
  body: string | null; image_path: string | null; created_at: string; deleted_at: string | null;
};

export const MESSAGE_COLUMNS = "id,conversation_id,sender_id,body,image_path,created_at,deleted_at";

export function conversationTitle(c: Pick<ConversationRow, "kind" | "title" | "other_name">): string {
  if (c.kind === "direct") return c.other_name ?? "Conversation";
  return c.title ?? "Group";
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
