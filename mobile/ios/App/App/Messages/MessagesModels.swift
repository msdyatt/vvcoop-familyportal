import Foundation

// The data Messages reads, as the database returns it. These mirror lib/messages.ts (the web is the spec): the same
// fields, the same rules for titles, who may post, how long a message can be edited, the six reactions.
// PostgREST sends snake_case; the decoder in SupabaseAPI turns it into these names.

enum ConversationKind: String, Codable { case direct, group, `class`, channel }

struct ConversationRow: Codable, Identifiable, Equatable {
    let id: String
    var kind: ConversationKind
    var title: String?
    var classId: String?
    var lastMessageAt: String
    var lastPreview: String?
    var lastSenderName: String?
    var unreadCount: Int
    var muted: Bool
    var memberCount: Int
    var otherUserId: String?
    var otherName: String?
    var otherAvatarPath: String?
    var topic: String?
    var posting: String
    var audience: String
    var archivedAt: String?
    var createdBy: String?
    var systemKey: String?
    /// A thread between a teacher and the parents of one student.
    var childThread: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(ConversationKind.self, forKey: .kind)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        classId = try c.decodeIfPresent(String.self, forKey: .classId)
        lastMessageAt = try c.decodeIfPresent(String.self, forKey: .lastMessageAt) ?? ""
        lastPreview = try c.decodeIfPresent(String.self, forKey: .lastPreview)
        lastSenderName = try c.decodeIfPresent(String.self, forKey: .lastSenderName)
        unreadCount = try c.decodeIfPresent(Int.self, forKey: .unreadCount) ?? 0
        muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
        memberCount = try c.decodeIfPresent(Int.self, forKey: .memberCount) ?? 0
        otherUserId = try c.decodeIfPresent(String.self, forKey: .otherUserId)
        otherName = try c.decodeIfPresent(String.self, forKey: .otherName)
        otherAvatarPath = try c.decodeIfPresent(String.self, forKey: .otherAvatarPath)
        topic = try c.decodeIfPresent(String.self, forKey: .topic)
        posting = try c.decodeIfPresent(String.self, forKey: .posting) ?? "everyone"
        audience = try c.decodeIfPresent(String.self, forKey: .audience) ?? "invite"
        archivedAt = try c.decodeIfPresent(String.self, forKey: .archivedAt)
        createdBy = try c.decodeIfPresent(String.self, forKey: .createdBy)
        systemKey = try c.decodeIfPresent(String.self, forKey: .systemKey)
        childThread = try c.decodeIfPresent(Bool.self, forKey: .childThread) ?? false
    }

    /// Direct chats are named for the other person; the rest by their title.
    var displayTitle: String {
        if kind == .direct { return otherName ?? "Conversation" }
        return title ?? (kind == .group ? "Group" : "Channel")
    }

    /// Channels and class channels are the shared, named spaces; the rest are private chats.
    var isChannel: Bool { kind == .channel || kind == .class }
    var isArchived: Bool { archivedAt != nil }
    var isBuiltIn: Bool { systemKey != nil }

    /// Whether this person may write here right now, and if not, why (lib/messages.ts postingBlock).
    func postingBlock(roles: [String]) -> String? {
        if isArchived { return "This channel is archived, so it is read-only." }
        if posting == "staff" && !roles.contains("admin") && !roles.contains("teacher") { return "Only administrators and teachers post in this channel." }
        return nil
    }

    /// Whether this person runs the channel: an administrator, or the person who made it.
    func isManaged(by userId: String, roles: [String]) -> Bool {
        kind == .channel && (roles.contains("admin") || createdBy == userId)
    }
}

struct Person: Codable, Identifiable, Equatable {
    let userId: String
    var displayName: String
    var avatarPath: String?
    var isTeacher: Bool
    var isAdmin: Bool
    var id: String { userId }

    init(userId: String, displayName: String, avatarPath: String? = nil, isTeacher: Bool = false, isAdmin: Bool = false) {
        self.userId = userId; self.displayName = displayName; self.avatarPath = avatarPath; self.isTeacher = isTeacher; self.isAdmin = isAdmin
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decode(String.self, forKey: .userId)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName) ?? "Former member"
        avatarPath = try c.decodeIfPresent(String.self, forKey: .avatarPath)
        isTeacher = try c.decodeIfPresent(Bool.self, forKey: .isTeacher) ?? false
        isAdmin = try c.decodeIfPresent(Bool.self, forKey: .isAdmin) ?? false
    }

    /// Role cue on an avatar ring: administrators first, then teachers.
    var ring: AvatarRing? { isAdmin ? .admin : isTeacher ? .teacher : nil }
}

enum AvatarRing { case admin, teacher }

struct MessageRow: Codable, Identifiable, Equatable {
    struct Reply: Codable, Equatable {
        let id: String
        var senderId: String?
        var body: String?
        var imagePath: String?
        var deletedAt: String?
    }

    let id: String
    var conversationId: String
    var senderId: String?
    var body: String?
    var imagePath: String?
    var createdAt: String
    var deletedAt: String?
    /// Set when the sender changed the words after sending.
    var editedAt: String?
    /// True when photos or files are attached; they are loaded separately (message_attachments).
    var hasAttachments: Bool
    var postId: String?
    var replyTo: String?
    /// Set on messages the system posted (a report card, say): who it is "from", and where its link goes.
    var systemLabel: String?
    var linkPath: String?
    var reply: Reply?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        senderId = try c.decodeIfPresent(String.self, forKey: .senderId)
        body = try c.decodeIfPresent(String.self, forKey: .body)
        imagePath = try c.decodeIfPresent(String.self, forKey: .imagePath)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        deletedAt = try c.decodeIfPresent(String.self, forKey: .deletedAt)
        editedAt = try c.decodeIfPresent(String.self, forKey: .editedAt)
        // Older rows/replicas may not include this newer flag; the absence means there are no extra attachments.
        hasAttachments = try c.decodeIfPresent(Bool.self, forKey: .hasAttachments) ?? false
        postId = try c.decodeIfPresent(String.self, forKey: .postId)
        replyTo = try c.decodeIfPresent(String.self, forKey: .replyTo)
        systemLabel = try c.decodeIfPresent(String.self, forKey: .systemLabel)
        linkPath = try c.decodeIfPresent(String.self, forKey: .linkPath)

        // PostgREST normally returns this many-to-one relation as an object. Accept a one-item array too,
        // because older schema-cache metadata can serialize a self-relation that way.
        if let nested = try? c.decode(Reply.self, forKey: .reply) {
            reply = nested
        } else if let nested = try? c.decode([Reply].self, forKey: .reply) {
            reply = nested.first
        } else {
            reply = nil
        }
    }

    /// News posts and system messages (a report, say) are shown as cards, not bubbles.
    var isCard: Bool { (postId != nil || systemLabel != nil) && deletedAt == nil }
    var isSystem: Bool { systemLabel != nil && deletedAt == nil }

    /// How long after sending a person can still edit a message. The database enforces the same limit.
    static let editWindow: TimeInterval = 24 * 60 * 60
    func canEdit(now: Date = Date()) -> Bool {
        guard deletedAt == nil, postId == nil, systemLabel == nil, let sent = MessageDates.parse(createdAt) else { return false }
        return now.timeIntervalSince(sent) < Self.editWindow
    }

    static let columns = "id,conversation_id,sender_id,body,image_path,created_at,deleted_at,edited_at,has_attachments,post_id,reply_to,system_label,link_path,reply:messages!reply_to(id,sender_id,body,image_path,deleted_at)"

    /// A short plain-text stand-in for a message, for reply quotes (lib/messages.ts snippet).
    static func snippet(body: String?, imagePath: String?, deletedAt: String?, max: Int = 80) -> String {
        if deletedAt != nil { return "Message removed" }
        if let body, !body.isEmpty { return body.count > max ? String(body.prefix(max)) + "…" : body }
        return imagePath != nil ? "Photo" : ""
    }
    var snippetText: String { Self.snippet(body: body, imagePath: imagePath, deletedAt: deletedAt) }
}

struct Reaction: Codable, Equatable, Hashable {
    let messageId: String
    let userId: String
    let emoji: String
}

/// The reactions on offer. The same list is enforced in the database.
let reactionChoices = ["👍", "❤️", "😂", "🎉", "🙏", "😮"]

struct Attachment: Codable, Identifiable, Equatable {
    let id: String
    var messageId: String
    var position: Int
    var kind: String
    var path: String
    var name: String
    var mime: String
    var sizeBytes: Int
    var isImage: Bool { kind == "image" }
}

struct SeenCount: Codable, Equatable {
    let messageId: String
    let seenCount: Int
    let totalCount: Int
}

struct SeenPerson: Codable, Identifiable, Equatable {
    let userId: String
    var displayName: String
    var avatarPath: String?
    var seen: Bool
    var id: String { userId }
}

// MARK: - Dates and short text

enum MessageDates {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    /// PostgREST timestamps: "2026-11-12T22:10:00.123456+00:00".
    static func parse(_ text: String) -> Date? {
        withFraction.date(from: text) ?? plain.date(from: text) ?? parseLong(text)
    }

    /// Microsecond fractions are not always accepted by ISO8601DateFormatter; cut them to milliseconds and try again.
    private static func parseLong(_ text: String) -> Date? {
        guard let dot = text.firstIndex(of: "."),
              let end = text[dot...].firstIndex(where: { $0 == "+" || $0 == "-" || $0 == "Z" }) else { return nil }
        let digits = text[text.index(after: dot)..<end]
        let trimmed = String(text[..<dot]) + "." + String(digits.prefix(3)).padding(toLength: 3, withPad: "0", startingAt: 0) + String(text[end...])
        return withFraction.date(from: trimmed)
    }

    private static let time: DateFormatter = { let f = DateFormatter(); f.timeStyle = .short; f.dateStyle = .none; return f }()
    private static let weekday: DateFormatter = { let f = DateFormatter(); f.setLocalizedDateFormatFromTemplate("EEE"); return f }()
    private static let monthDay: DateFormatter = { let f = DateFormatter(); f.setLocalizedDateFormatFromTemplate("MMM d"); return f }()
    private static let longDay: DateFormatter = { let f = DateFormatter(); f.setLocalizedDateFormatFromTemplate("EEEE, MMMM d"); return f }()

    /// "2:14 PM" today, "Tue" this week, otherwise "Nov 4" (lib/messages.ts shortTime).
    static func shortTime(_ iso: String, now: Date = Date()) -> String {
        guard let date = parse(iso) else { return "" }
        if Calendar.current.isDate(date, inSameDayAs: now) { return time.string(from: date) }
        if now.timeIntervalSince(date) / 86_400 < 6 { return weekday.string(from: date) }
        return monthDay.string(from: date)
    }

    static func clock(_ iso: String) -> String { parse(iso).map { time.string(from: $0) } ?? "" }

    /// "Today", "Yesterday", or "Tuesday, November 12" (lib/messages.ts dayLabel).
    static func dayLabel(_ iso: String, now: Date = Date()) -> String {
        guard let date = parse(iso) else { return "" }
        if Calendar.current.isDate(date, inSameDayAs: now) { return "Today" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return longDay.string(from: date)
    }
}

/// Splits a message into plain text and @mentions of people in the conversation, longest names first so
/// "@Sam Dyatt" wins over "@Sam" (lib/messages.ts splitMentions).
func splitMentions(_ body: String, names: [String]) -> [(text: String, mention: Bool)] {
    let usable = Array(Set(names.filter { !$0.isEmpty })).sorted { $0.count > $1.count }
    guard !usable.isEmpty, body.contains("@") else { return [(body, false)] }
    let alternatives = usable.map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: "|")
    guard let regex = try? NSRegularExpression(pattern: "@(?:\(alternatives))(?![\\p{L}\\p{N}])") else { return [(body, false)] }
    let ns = body as NSString
    var parts: [(String, Bool)] = []
    var cursor = 0
    for match in regex.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
        if match.range.location > cursor { parts.append((ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor)), false)) }
        parts.append((ns.substring(with: match.range), true))
        cursor = match.range.location + match.range.length
    }
    if cursor < ns.length { parts.append((ns.substring(from: cursor), false)) }
    return parts.map { (text: $0.0, mention: $0.1) }
}

func formatBytes(_ bytes: Int) -> String {
    if bytes < 1024 { return "\(bytes) B" }
    if bytes < 1024 * 1024 { return "\(Int((Double(bytes) / 1024).rounded())) KB" }
    return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
}

/// "Maria", "Maria and James", "Maria, James and Ana".
func joinNames(_ names: [String]) -> String {
    if names.count <= 1 { return names.first ?? "" }
    return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
}

// MARK: - Colour choice (lib/message-colors.ts)

enum MessageTone {
    static let count = 6

    /// The palette index (0 to 5) for an id. FNV-1a over the UTF-16 code units, exactly as the web does it, so a person has
    /// the same colour on every device.
    static func toneFor(_ id: String?) -> Int {
        guard let id else { return 3 }
        var hash: UInt32 = 0x811c9dc5
        for unit in id.utf16 {
            hash ^= UInt32(unit)
            hash = hash &* 0x01000193
        }
        return Int(hash % UInt32(count))
    }
}

enum ConversationFlavour: String {
    case direct, family, group, `class`, channel

    /// The small caps line above a conversation's title. Direct chats have none.
    var label: String {
        switch self {
        case .direct: return ""
        case .family: return "Family thread"
        case .group: return "Group"
        case .class: return "Class chat"
        case .channel: return "Channel"
        }
    }
}

extension ConversationRow {
    var flavour: ConversationFlavour {
        switch kind {
        case .channel: return .channel
        case .class: return .class
        case .direct: return .direct
        case .group: return childThread ? .family : .group
        }
    }

    /// A channel is terracotta, a class chat gold, a family thread sage, a group slate-teal; a direct chat takes the other person's tint.
    var tone: Int {
        switch flavour {
        case .channel: return 0
        case .class: return 1
        case .family: return 2
        case .group: return 5
        case .direct: return MessageTone.toneFor(otherUserId ?? id)
        }
    }
}
