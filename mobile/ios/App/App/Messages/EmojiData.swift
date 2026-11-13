import Foundation

/// The emoji offered in the composer, in groups (lib/emoji.ts). The phone's own emoji; the six reactions are a separate, smaller set the
/// database allows.
struct EmojiGroup: Identifiable {
    let id: String
    let label: String
    let icon: String
    let emoji: [String]
}

let emojiGroups: [EmojiGroup] = [
    EmojiGroup(id: "smileys", label: "Faces", icon: "😀", emoji: ["😀", "😃", "😄", "😁", "😆", "😂", "🤣", "😊", "🙂", "😉", "😍", "🥰", "😘", "😎", "🤓", "🤔", "😐", "😴", "😮", "😢", "😭", "😅", "😬", "🥳", "🤗", "🙃", "😇", "🥹"]),
    EmojiGroup(id: "hands", label: "Hands", icon: "👍", emoji: ["👍", "👎", "👏", "🙌", "🙏", "🤝", "💪", "👋", "✌️", "🤞", "👌", "☝️", "👀", "🫶", "🤷", "🙋"]),
    EmojiGroup(id: "hearts", label: "Hearts", icon: "❤️", emoji: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🤍", "💕", "💖", "💯", "✨", "⭐", "🌟", "🔥"]),
    EmojiGroup(id: "celebrate", label: "Celebrate", icon: "🎉", emoji: ["🎉", "🎊", "🎂", "🎈", "🎁", "🏆", "🥇", "🎶", "📣", "🙏", "✅", "❗", "❓", "📌"]),
    EmojiGroup(id: "school", label: "School", icon: "📚", emoji: ["📚", "✏️", "📝", "🎒", "🔬", "🎨", "🎭", "⚽", "🏀", "🎻", "🚌", "🏫", "🗓️", "⏰", "💡", "🧮"]),
    EmojiGroup(id: "nature", label: "Nature & food", icon: "🌳", emoji: ["☀️", "🌧️", "🌈", "❄️", "🌸", "🌳", "🍎", "🍕", "🍪", "☕", "🥪", "🍉", "🐶", "🐱", "🦋", "🐢"]),
]
