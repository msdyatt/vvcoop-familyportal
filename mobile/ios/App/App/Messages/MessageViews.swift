import SwiftUI

// The pieces a thread is made of: bubbles in runs, news and system cards, photos and files, reaction chips and the tap-for-actions bar.
// The look is the web's (app/globals.css "Messages: look and feel"), in the app's own palette.

/// A bubble with its own radius for each corner: your bubbles tighten on the right inside a run, others' on the left, and the last
/// bubble of a run gets the small corner.
struct BubbleShape: Shape {
    var topLeading: CGFloat, topTrailing: CGFloat, bottomLeading: CGFloat, bottomTrailing: CGFloat

    func path(in rect: CGRect) -> Path {
        let tl = min(topLeading, min(rect.width, rect.height) / 2), tr = min(topTrailing, min(rect.width, rect.height) / 2)
        let bl = min(bottomLeading, min(rect.width, rect.height) / 2), br = min(bottomTrailing, min(rect.width, rect.height) / 2)
        var p = Path()
        p.move(to: CGPoint(x: rect.minX + tl, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX - tr, y: rect.minY))
        p.addArc(center: CGPoint(x: rect.maxX - tr, y: rect.minY + tr), radius: tr, startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - br))
        p.addArc(center: CGPoint(x: rect.maxX - br, y: rect.maxY - br), radius: br, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX + bl, y: rect.maxY))
        p.addArc(center: CGPoint(x: rect.minX + bl, y: rect.maxY - bl), radius: bl, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + tl))
        p.addArc(center: CGPoint(x: rect.minX + tl, y: rect.minY + tl), radius: tl, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        p.closeSubpath()
        return p
    }
}

/// A message with its day label and where it sits in a run: a run is the messages one person sends in a row, with under ten minutes
/// between them and none on another day. The first of a run carries the name, the last carries the photo and the time. News and system
/// cards stand alone.
struct ThreadItem: Identifiable {
    let message: MessageRow
    let day: String
    let showDay: Bool
    let startsRun: Bool
    var endsRun: Bool
    var card: Bool { message.isCard }
    var id: String { message.id }

    static let runGap: TimeInterval = 10 * 60

    static func build(_ messages: [MessageRow]) -> [ThreadItem] {
        var previousDay = ""
        var previous: MessageRow?
        var items: [ThreadItem] = []
        for message in messages {
            let day = MessageDates.dayLabel(message.createdAt)
            let showDay = day != previousDay
            var starts = showDay || previous == nil || message.isCard || (previous?.isCard ?? false)
                || previous?.senderId != message.senderId || previous?.postId != message.postId
            if !starts, let before = previous, let a = MessageDates.parse(before.createdAt), let b = MessageDates.parse(message.createdAt), b.timeIntervalSince(a) > runGap { starts = true }
            previousDay = day
            previous = message
            items.append(ThreadItem(message: message, day: day, showDay: showDay, startsRun: starts, endsRun: false))
        }
        for index in items.indices {
            items[index].endsRun = items[index].card || index == items.count - 1 || items[index + 1].startsRun
        }
        return items
    }
}

/// Everything a row needs from the thread: who is who, and what to do when something is tapped.
struct ThreadEnv {
    var userId: String
    var conversation: ConversationRow
    var people: [String: Person]
    var roles: [String]
    var blocked: Bool
    var maxBubble: CGFloat
    var seenAllowed: Bool
    var seenCounts: [String: SeenCount]
    var reactions: [Reaction]
    var attachments: [String: [Attachment]]
    var activeId: String?

    var toggle: (String) -> Void = { _ in }
    var react: (String, String) -> Void = { _, _ in }
    var reply: (MessageRow) -> Void = { _ in }
    var edit: (MessageRow) -> Void = { _ in }
    var remove: (MessageRow) -> Void = { _ in }
    var report: (MessageRow) -> Void = { _ in }
    var copy: (MessageRow) -> Void = { _ in }
    var whoReacted: (String) -> Void = { _ in }
    var seenBy: (String) -> Void = { _ in }
    var photos: ([String], Int) -> Void = { _, _ in }
    var file: (Attachment) -> Void = { _ in }
    var jumpTo: (String) -> Void = { _ in }
    var open: (URL) -> Void = { _ in }

    func name(of id: String?) -> String {
        guard let id else { return "Former member" }
        return id == userId ? "You" : people[id]?.displayName ?? "Former member"
    }
}

// MARK: - Bubble row

struct MessageRowView: View {
    let item: ThreadItem
    let env: ThreadEnv

    private var message: MessageRow { item.message }
    private var mine: Bool { message.senderId == env.userId }
    private var open: Bool { env.activeId == message.id }
    private var group: Bool { env.conversation.kind != .direct }
    private var sender: Person? { message.senderId.flatMap { env.people[$0] } }
    private var tone: Int { item.card ? env.conversation.tone : MessageTone.toneFor(message.senderId) }
    private var own: [Reaction] { env.reactions.filter { $0.messageId == message.id } }
    private var media: [Attachment] { MessageMedia.attachments(for: message, loaded: env.attachments) }

    var body: some View {
        VStack(spacing: 0) {
            if item.showDay { DayPill(text: item.day) }
            if item.card { CardView(item: item, env: env).padding(.vertical, 8) } else { bubbleRow }
        }
        .id(message.id)
    }

    private var bubbleRow: some View {
        let showName = !mine && group && item.startsRun
        let showAvatar = group && !mine
        return VStack(alignment: mine ? .trailing : .leading, spacing: 0) {
            if showName {
                HStack(spacing: 0) {
                    Text(sender?.displayName ?? "Former member").font(.footnote.weight(.bold)).foregroundColor(MT.name(tone)).lineLimit(1)
                    if sender?.isTeacher == true { RoleTag(text: "Teacher", tone: tone) }
                    if sender?.isAdmin == true { RoleTag(text: "Admin", tone: tone) }
                }
                .padding(.leading, 14 + (showAvatar ? 36 : 0)).padding(.bottom, 3)
            }
            HStack(alignment: .bottom, spacing: 8) {
                if showAvatar {
                    if item.endsRun {
                        AvatarView(label: sender?.displayName ?? "?", path: sender?.avatarPath, tone: tone, ring: sender?.ring, size: 28)
                    } else { Color.clear.frame(width: 28, height: 28) }
                }
                bubble
            }
            if open { tools }
            else if item.endsRun || message.editedAt != nil { meta }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .padding(.top, item.startsRun ? 12 : 2)
        .padding(.bottom, own.isEmpty || message.deletedAt != nil ? 0 : 14)
    }

    // MARK: Bubble

    private var shape: BubbleShape {
        let big: CGFloat = 19, mid: CGFloat = 6, tail: CGFloat = 4
        if mine {
            return BubbleShape(topLeading: big, topTrailing: item.startsRun ? big : mid, bottomLeading: big, bottomTrailing: item.endsRun ? tail : mid)
        }
        return BubbleShape(topLeading: item.startsRun ? big : mid, topTrailing: big, bottomLeading: item.endsRun ? tail : mid, bottomTrailing: big)
    }

    @ViewBuilder private var bubble: some View {
        if message.deletedAt != nil {
            Text("Message removed").font(.subheadline.italic()).foregroundColor(MT.muted)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .overlay(shape.stroke(MT.line, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                .accessibilityLabel("Message removed")
        } else {
            let images = media.filter(\.isImage), files = media.filter { !$0.isImage }
            let photoOnly = !images.isEmpty && files.isEmpty && (message.body ?? "").isEmpty && message.reply == nil
            WidthCap(cap: env.maxBubble - (photoOnly ? 0 : (media.isEmpty ? 28 : 8))) {
              VStack(alignment: .leading, spacing: 4) {
                if !images.isEmpty { MediaGrid(images: images, env: env, width: env.maxBubble - (photoOnly ? 0 : 8)) }
                if !files.isEmpty { FileList(files: files, env: env, mine: mine) }
                if message.hasAttachments && env.attachments[message.id] == nil { Text("Loading…").font(.footnote).foregroundColor(MT.muted).padding(8) }
                if message.replyTo != nil, let reply = message.reply { QuoteView(reply: reply, env: env, mine: mine, tone: tone) }
                if let body = message.body, !body.isEmpty {
                    MessageText(content: body, names: env.people.values.map(\.displayName), me: env.people[env.userId]?.displayName ?? "", mine: mine, open: env.open)
                        .padding(.horizontal, images.isEmpty && files.isEmpty ? 0 : 10).padding(.top, images.isEmpty ? 0 : 4).padding(.bottom, images.isEmpty ? 0 : 2)
                }
              }
            }
            .padding(.horizontal, photoOnly ? 0 : (media.isEmpty ? 14 : 4)).padding(.vertical, photoOnly ? 0 : (media.isEmpty ? 9 : 4))
            .fixedSize(horizontal: false, vertical: true)
            .background(photoOnly ? Color.clear : (mine ? MT.action : MT.wash(tone)), in: shape)
            .clipShape(shape)
            .overlay(alignment: mine ? .bottomTrailing : .bottomLeading) {
                if !own.isEmpty { ReactionChips(message: message, reactions: own, env: env).offset(x: mine ? -8 : 8, y: 14) }
            }
            .overlay(shape.stroke(MT.text.opacity(open ? 0.22 : 0), lineWidth: 3))
            .contentShape(shape)
            .onTapGesture { env.toggle(message.id) }
            .contextMenu { menu }
            .accessibilityElement(children: .combine)
            .accessibilityAction(named: "Show actions") { env.toggle(message.id) }
        }
    }

    // MARK: Long-press menu

    @ViewBuilder private var menu: some View {
        if message.deletedAt == nil {
            if !env.conversation.isArchived {
                Menu {
                    ForEach(reactionChoices, id: \.self) { emoji in Button(emoji) { env.react(message.id, emoji) } }
                } label: { Label("React", systemImage: "face.smiling") }
            }
            if !env.blocked { Button { env.reply(message) } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") } }
            if let body = message.body, !body.isEmpty { Button { env.copy(message) } label: { Label("Copy", systemImage: "doc.on.doc") } }
            if mine && !env.conversation.isArchived && message.canEdit() { Button { env.edit(message) } label: { Label("Edit", systemImage: "pencil") } }
            if mine { Button(role: .destructive) { env.remove(message) } label: { Label("Remove", systemImage: "trash") } }
            if !mine && message.systemLabel == nil { Button(role: .destructive) { env.report(message) } label: { Label("Report", systemImage: "flag") } }
        }
    }

    // MARK: Under the bubble

    private var meta: some View {
        HStack(spacing: 8) {
            if item.endsRun { Text(MessageDates.clock(message.createdAt)) }
            if message.editedAt != nil && message.deletedAt == nil { Text("Edited") }
            if env.seenAllowed, let seen = env.seenCounts[message.id], message.deletedAt == nil {
                Text("· Seen by \(seen.seenCount) of \(seen.totalCount)")
            }
        }
        .font(.caption).foregroundColor(MT.muted)
        .padding(.top, 4).padding(.horizontal, 14).padding(.leading, group && !mine ? 36 : 0)
    }

    /// Tap a message: the reaction bar, its time, who has seen it, and what can be done with it.
    private var tools: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
            if message.deletedAt == nil && !env.conversation.isArchived {
                HStack(spacing: 0) {
                    ForEach(reactionChoices, id: \.self) { emoji in
                        let mineNow = own.contains { $0.emoji == emoji && $0.userId == env.userId }
                        Button { env.react(message.id, emoji) } label: {
                            Text(emoji).font(.system(size: 23)).frame(width: 42, height: 42)
                                .background(Circle().fill(mineNow ? MT.terracotta.opacity(0.28) : Color.clear))
                                .overlay(Circle().stroke(mineNow ? MT.terracotta : Color.clear, lineWidth: 1.5))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("React \(emoji)").accessibilityAddTraits(mineNow ? .isSelected : [])
                    }
                }
                .padding(3).background(MT.surface, in: Capsule()).overlay(Capsule().stroke(MT.line, lineWidth: 1))
                .shadow(color: .black.opacity(0.14), radius: 10, y: 4)
            }
            HStack(spacing: 8) {
                Text(MessageDates.clock(message.createdAt))
                if message.editedAt != nil && message.deletedAt == nil { Text("Edited") }
                if env.seenAllowed, let seen = env.seenCounts[message.id], message.deletedAt == nil {
                    Button("Seen by \(seen.seenCount) of \(seen.totalCount)") { env.seenBy(message.id) }.foregroundColor(MT.accentText).font(.caption.weight(.semibold))
                }
            }
            .font(.caption).foregroundColor(MT.muted)
            if message.deletedAt == nil {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        if !env.blocked { pill("Reply") { env.reply(message) } }
                        if !own.isEmpty { pill("Who reacted") { env.whoReacted(message.id) } }
                        if mine && !env.conversation.isArchived && message.canEdit() { pill("Edit") { env.edit(message) } }
                        if mine { pill("Remove") { env.remove(message) } }
                        if !mine && message.systemLabel == nil { pill("Report") { env.report(message) } }
                    }
                }
                .frame(maxWidth: env.maxBubble)
            }
        }
        .padding(.top, 6).padding(.horizontal, 14).padding(.leading, group && !mine ? 36 : 0)
        .transition(reduceMotion ? .identity : .opacity.combined(with: .scale(scale: 0.96, anchor: mine ? .topTrailing : .topLeading)))
    }

    private func pill(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.caption.weight(.semibold)).foregroundColor(MT.text).padding(.horizontal, 11).padding(.vertical, 5)
                .background(MT.sunken, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Small parts

struct DayPill: View {
    let text: String
    var body: some View {
        Text(text).font(.caption.weight(.semibold)).foregroundColor(MT.muted)
            .padding(.horizontal, 13).padding(.vertical, 4).background(MT.sunken, in: Capsule())
            .frame(maxWidth: .infinity).padding(.top, 18).padding(.bottom, 10)
            .accessibilityAddTraits(.isHeader)
    }
}

struct RoleTag: View {
    let text: String
    let tone: Int
    var body: some View {
        Text(text.uppercased()).font(.system(size: 9.5, weight: .bold)).tracking(0.8).foregroundColor(MT.name(tone))
            .padding(.horizontal, 7).padding(.vertical, 1.5).background(MT.wash(tone), in: Capsule()).padding(.leading, 7)
    }
}

/// A reply's quoted message, with a bar in the sender's colour.
struct QuoteView: View {
    let reply: MessageRow.Reply
    let env: ThreadEnv
    let mine: Bool
    let tone: Int
    var body: some View {
        Button { env.jumpTo(reply.id) } label: {
            VStack(alignment: .leading, spacing: 1) {
                Text(env.name(of: reply.senderId)).font(.caption.weight(.bold)).foregroundColor(mine ? MT.accentOnAction : MT.name(MessageTone.toneFor(reply.senderId)))
                Text(MessageRow.snippet(body: reply.body, imagePath: reply.imagePath, deletedAt: reply.deletedAt)).font(.caption).lineLimit(2)
                    .foregroundColor(mine ? Color(MT.cream) : MT.text)
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(mine ? Color.white.opacity(0.13) : MT.canvas.opacity(0.55), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(alignment: .leading) { Rectangle().fill(mine ? MT.accentOnAction : MT.fill(MessageTone.toneFor(reply.senderId))).frame(width: 3).clipShape(RoundedRectangle(cornerRadius: 1.5)) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Reply to \(env.name(of: reply.senderId)): \(MessageRow.snippet(body: reply.body, imagePath: reply.imagePath, deletedAt: reply.deletedAt))")
    }
}

/// The words of a message, with @mentions of people in the conversation picked out and links tappable.
struct MessageText: View {
    let content: String
    let names: [String]
    let me: String
    let mine: Bool
    let open: (URL) -> Void

    private var attributed: AttributedString {
        var result = AttributedString()
        for part in splitMentions(content, names: names) {
            var piece = AttributedString(part.text)
            if part.mention {
                piece.font = .body.bold()
                if mine { piece.foregroundColor = MT.accentOnAction; piece.backgroundColor = Color.white.opacity(0.14) }
                else if part.text == "@\(me)" { piece.foregroundColor = MT.dangerText; piece.backgroundColor = MT.warmTint }
                else { piece.backgroundColor = Color.primary.opacity(0.08) }
            }
            result.append(piece)
        }
        let plain = String(result.characters)
        if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
            for match in detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
                guard let url = match.url, let range = Range(match.range, in: plain) else { continue }
                let from = result.index(result.startIndex, offsetByCharacters: plain.distance(from: plain.startIndex, to: range.lowerBound))
                let to = result.index(result.startIndex, offsetByCharacters: plain.distance(from: plain.startIndex, to: range.upperBound))
                result[from..<to].link = url
                result[from..<to].underlineStyle = .single
            }
        }
        return result
    }

    var body: some View {
        Text(attributed).font(.body).foregroundColor(mine ? Color(MT.cream) : MT.text).tint(mine ? MT.accentOnAction : MT.accentText)
            .fixedSize(horizontal: false, vertical: true)
            .environment(\.openURL, OpenURLAction { url in open(url); return .handled })
    }
}

/// Gives its one child at most `cap` points of width, and takes the size the child chooses: a short message is a short bubble, a long
/// one wraps at the cap. (`frame(maxWidth:)` would take all the width offered instead.)
struct WidthCap: Layout {
    var cap: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        return child.sizeThatFits(ProposedViewSize(width: min(proposal.width ?? cap, cap), height: proposal.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}
