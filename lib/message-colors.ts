import type { ConversationRow } from "./messages";

/**
 * Colour for people and conversations in Messages.
 *
 * Six tints, all derived from the brand palette (terracotta, antique gold,
 * sage, a navy tint, a clay/rose and a slate-teal). Each is a set of CSS
 * variables defined by `.pc-0` .. `.pc-5` in app/globals.css (fill for
 * avatars, wash for bubbles, a text-safe name colour), so the only decision
 * made here is which of the six. It is made from the person's id, so the same
 * person has the same colour in the list, the bubbles and the details, on
 * every device, and nothing has to be stored.
 */
export const TONES = 6;

/** The palette index (0 to 5) for an id. FNV-1a, so it is stable and spreads similar ids apart. */
export function toneFor(id: string | null | undefined): number {
  if (!id) return 3;
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % TONES;
}

/** Fixed tints for the kinds of conversation; a direct chat takes the other person's tint instead. */
const TONE_CHANNEL = 0; // terracotta
const TONE_CLASS = 1; // antique gold
const TONE_FAMILY = 2; // sage
const TONE_GROUP = 5; // slate-teal

export type ConversationFlavour = "direct" | "family" | "group" | "class" | "channel";

export function conversationFlavour(c: Pick<ConversationRow, "kind" | "child_thread">): ConversationFlavour {
  if (c.kind === "channel") return "channel";
  if (c.kind === "class") return "class";
  if (c.kind === "direct") return "direct";
  return c.child_thread ? "family" : "group";
}

export function conversationTone(c: Pick<ConversationRow, "kind" | "child_thread" | "other_user_id" | "id">): number {
  switch (conversationFlavour(c)) {
    case "channel": return TONE_CHANNEL;
    case "class": return TONE_CLASS;
    case "family": return TONE_FAMILY;
    case "group": return TONE_GROUP;
    default: return toneFor(c.other_user_id ?? c.id);
  }
}

/** The small caps line above a conversation's title. Direct chats have none. */
export const FLAVOUR_LABEL: Record<ConversationFlavour, string> = {
  direct: "", family: "Family thread", group: "Group", class: "Class chat", channel: "Channel",
};

/** Role cue on an avatar ring: administrators first, then teachers. */
export function roleRing(person: { is_admin?: boolean; is_teacher?: boolean } | undefined): "admin" | "teacher" | null {
  if (person?.is_admin) return "admin";
  if (person?.is_teacher) return "teacher";
  return null;
}
