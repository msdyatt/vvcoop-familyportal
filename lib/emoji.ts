/**
 * The emoji offered in the composer, in groups. These are the phone's own emoji, so they look like the
 * phone's. The six reactions (REACTIONS in lib/messages.ts) are a separate, smaller set the database allows.
 * When the co-op's own emoji arrive they replace this list; nothing else needs to know what is in it.
 */
export type EmojiGroup = { id: string; label: string; icon: string; emoji: string[] };

export const EMOJI_GROUPS: EmojiGroup[] = [
  { id: "smileys", label: "Faces", icon: "😀", emoji: ["😀", "😃", "😄", "😁", "😆", "😂", "🤣", "😊", "🙂", "😉", "😍", "🥰", "😘", "😎", "🤓", "🤔", "😐", "😴", "😮", "😢", "😭", "😅", "😬", "🥳", "🤗", "🙃", "😇", "🥹"] },
  { id: "hands", label: "Hands", icon: "👍", emoji: ["👍", "👎", "👏", "🙌", "🙏", "🤝", "💪", "👋", "✌️", "🤞", "👌", "☝️", "👀", "🫶", "🤷", "🙋"] },
  { id: "hearts", label: "Hearts", icon: "❤️", emoji: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🤍", "💕", "💖", "💯", "✨", "⭐", "🌟", "🔥"] },
  { id: "celebrate", label: "Celebrate", icon: "🎉", emoji: ["🎉", "🎊", "🎂", "🎈", "🎁", "🏆", "🥇", "🎶", "📣", "🙏", "✅", "❗", "❓", "📌"] },
  { id: "school", label: "School", icon: "📚", emoji: ["📚", "✏️", "📝", "🎒", "🔬", "🎨", "🎭", "⚽", "🏀", "🎻", "🚌", "🏫", "🗓️", "⏰", "💡", "🧮"] },
  { id: "nature", label: "Nature & food", icon: "🌳", emoji: ["☀️", "🌧️", "🌈", "❄️", "🌸", "🌳", "🍎", "🍕", "🍪", "☕", "🥪", "🍉", "🐶", "🐱", "🦋", "🐢"] },
];
