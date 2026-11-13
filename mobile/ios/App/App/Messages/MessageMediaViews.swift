import SwiftUI

enum MessageMedia {
    /// Photos and files on a message. Older messages carry one photo in image_path and no attachment rows.
    static func attachments(for message: MessageRow, loaded: [String: [Attachment]]) -> [Attachment] {
        if message.hasAttachments { return loaded[message.id] ?? [] }
        if let path = message.imagePath {
            return [Attachment(id: message.id, messageId: message.id, position: 0, kind: "image", path: path, name: "Photo", mime: "image/jpeg", sizeBytes: 0)]
        }
        return []
    }
}

/// One to four photos in a grid; more than four show "+N" on the fourth. A tap opens them full size.
struct MediaGrid: View {
    let images: [Attachment]
    let env: ThreadEnv
    let width: CGFloat

    private var shown: [Attachment] { Array(images.prefix(4)) }

    var body: some View {
        let paths = images.map(\.path)
        Group {
            switch shown.count {
            case 1:
                tile(0, paths: paths).frame(maxWidth: width).frame(maxHeight: 300)
            case 2:
                HStack(spacing: 3) { square(0, paths); square(1, paths) }.frame(width: width)
            case 3:
                VStack(spacing: 3) {
                    Color.clear.aspectRatio(2, contentMode: .fit).overlay { tile(0, paths: paths, fill: true) }.clipped()
                    HStack(spacing: 3) { square(1, paths); square(2, paths) }
                }.frame(width: width)
            default:
                VStack(spacing: 3) {
                    HStack(spacing: 3) { square(0, paths); square(1, paths) }
                    HStack(spacing: 3) { square(2, paths); square(3, paths) }
                }.frame(width: width)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
    }

    private func square(_ index: Int, _ paths: [String]) -> some View {
        Color.clear.aspectRatio(1, contentMode: .fit).overlay { tile(index, paths: paths, fill: true) }.clipped()
    }

    private func tile(_ index: Int, paths: [String], fill: Bool = false) -> some View {
        let item = shown[index]
        return Button { env.photos(paths, index) } label: {
            StoredImage(path: item.path, contentMode: fill ? .fill : .fit) {
                ZStack { MT.sunken; ProgressView() }.frame(minWidth: 120, minHeight: 120)
            }
            .overlay {
                if index == 3, images.count > 4 {
                    ZStack { Color.black.opacity(0.45); Text("+\(images.count - 4)").font(.title2.weight(.bold)).foregroundColor(.white) }
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(images.count > 1 ? "Open photo \(index + 1) of \(images.count)" : "Open photo")
    }
}

/// Documents on a message: a row with the name and size; a tap opens a preview.
struct FileList: View {
    let files: [Attachment]
    let env: ThreadEnv
    var mine: Bool = false

    var body: some View {
        VStack(spacing: 4) {
            ForEach(files) { file in
                Button { env.file(file) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "doc.text").font(.title3)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(file.name).font(.subheadline.weight(.semibold)).lineLimit(2).multilineTextAlignment(.leading)
                            Text(formatBytes(file.sizeBytes)).font(.caption).opacity(0.75)
                        }
                        Spacer(minLength: 0)
                    }
                    .foregroundColor(mine ? Color(MT.cream) : MT.text)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background((mine ? Color.white : MT.text).opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("File: \(file.name), \(formatBytes(file.sizeBytes))")
            }
        }
    }
}

/// Small terracotta-washed pills hung on the bubble's lower edge: each reaction with its count; a tap toggles yours.
struct ReactionChips: View {
    let message: MessageRow
    let reactions: [Reaction]
    let env: ThreadEnv

    var body: some View {
        HStack(spacing: 3) {
            ForEach(reactionChoices, id: \.self) { emoji in
                let count = reactions.filter { $0.emoji == emoji }.count
                if count > 0 {
                    let mine = reactions.contains { $0.emoji == emoji && $0.userId == env.userId }
                    Button { env.react(message.id, emoji) } label: {
                        HStack(spacing: 3) {
                            Text(emoji).font(.system(size: 12.5))
                            Text("\(count)").font(.system(size: 11.5, weight: .bold))
                        }
                        .foregroundColor(MT.dangerText).padding(.leading, 5).padding(.trailing, 7).padding(.vertical, 1)
                        .background(mine ? MT.terracotta.opacity(0.3) : MT.warmTint, in: Capsule())
                        .overlay(Capsule().stroke(mine ? MT.terracotta : MT.surface, lineWidth: 1.5))
                        .shadow(color: .black.opacity(0.2), radius: 1.5, y: 1)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(emoji) \(count)\(mine ? ", you reacted" : "")")
                }
            }
        }
        .fixedSize()
    }
}

/// News posts and system messages (a report, say) as full-width cards, not bubbles.
struct CardView: View {
    let item: ThreadItem
    let env: ThreadEnv

    private var message: MessageRow { item.message }
    private var system: Bool { message.isSystem }
    private var open: Bool { env.activeId == message.id }
    private var sender: Person? { message.senderId.flatMap { env.people[$0] } }
    private var own: [Reaction] { env.reactions.filter { $0.messageId == message.id } }
    private var fill: Color { system ? MT.fill(env.conversation.tone) : MT.terracotta }

    var body: some View {
        let lines = (message.body ?? "").components(separatedBy: "\n")
        let headline = lines.first ?? ""
        let rest = Array(lines.dropFirst())
        let media = MessageMedia.attachments(for: message, loaded: env.attachments)
        let images = media.filter(\.isImage), files = media.filter { !$0.isImage }
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                HStack(spacing: 7) {
                    Rectangle().fill(MT.terracotta).frame(width: 7, height: 7).rotationEffect(.degrees(45))
                    Text((system ? message.systemLabel ?? "" : "News").uppercased()).font(.system(size: 11, weight: .bold)).tracking(1.3).foregroundColor(MT.accentText)
                }
                Spacer()
                Text(MessageDates.shortTime(message.createdAt)).font(.caption).foregroundColor(MT.muted)
            }
            Text(headline).font(MT.serif(.title3)).foregroundColor(MT.text).fixedSize(horizontal: false, vertical: true)
            if !images.isEmpty { MediaGrid(images: images, env: env, width: env.maxBubble + 60) }
            if !files.isEmpty { FileList(files: files, env: env) }
            if message.replyTo != nil, let reply = message.reply { QuoteView(reply: reply, env: env, mine: false, tone: env.conversation.tone) }
            let body = system ? rest.filter { !$0.isEmpty }.joined(separator: "\n") : rest.joined(separator: "\n")
            if !body.isEmpty { Text(body).font(.callout).foregroundColor(MT.text).fixedSize(horizontal: false, vertical: true) }
            Divider().padding(.top, 4)
            HStack(spacing: 14) {
                if system {
                    if let path = message.linkPath { linkButton("Open in review →", path: path) }
                } else {
                    linkButton("Read in News →", path: "/family-village/news")
                    if let sender { Text("Posted by \(sender.displayName)").font(.caption).foregroundColor(MT.muted) }
                }
                Spacer(minLength: 0)
                if env.seenAllowed, let seen = env.seenCounts[message.id] {
                    Button("Seen by \(seen.seenCount) of \(seen.totalCount)") { env.seenBy(message.id) }.font(.caption.weight(.semibold)).foregroundColor(MT.accentText)
                }
            }
            .font(.caption)
            if open {
                if !env.conversation.isArchived {
                    HStack(spacing: 0) {
                        ForEach(reactionChoices, id: \.self) { emoji in
                            let mineNow = own.contains { $0.emoji == emoji && $0.userId == env.userId }
                            Button { env.react(message.id, emoji) } label: {
                                Text(emoji).font(.system(size: 23)).frame(width: 42, height: 42)
                                    .background(Circle().fill(mineNow ? MT.terracotta.opacity(0.28) : Color.clear))
                                    .overlay(Circle().stroke(mineNow ? MT.terracotta : Color.clear, lineWidth: 1.5))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(3).background(MT.surface, in: Capsule()).overlay(Capsule().stroke(MT.line, lineWidth: 1))
                }
                HStack(spacing: 6) {
                    if !env.blocked { actionPill("Reply") { env.reply(message) } }
                    if !own.isEmpty { actionPill("Who reacted") { env.whoReacted(message.id) } }
                    if message.senderId == env.userId { actionPill("Remove") { env.remove(message) } }
                    if message.senderId != env.userId && message.systemLabel == nil { actionPill("Report") { env.report(message) } }
                }
            }
            if !own.isEmpty { ReactionChips(message: message, reactions: own, env: env).frame(maxWidth: .infinity, alignment: .trailing) }
        }
        .padding(.horizontal, 16).padding(.top, 17).padding(.bottom, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MT.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(alignment: .top) { fill.frame(height: 4).clipShape(UnevenCap()) }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(MT.line, lineWidth: 1))
        .shadow(color: .black.opacity(0.06), radius: 5, y: 2)
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .onTapGesture { env.toggle(message.id) }
        .contextMenu {
            if !env.blocked { Button { env.reply(message) } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") } }
            if message.senderId != env.userId && message.systemLabel == nil { Button(role: .destructive) { env.report(message) } label: { Label("Report", systemImage: "flag") } }
        }
        .accessibilityElement(children: .contain)
    }

    private func linkButton(_ title: String, path: String) -> some View {
        Button(title) { env.open(FrameConfig.url(forPath: path)) }.font(.caption.weight(.bold)).foregroundColor(MT.accentText)
    }

    private func actionPill(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.caption.weight(.semibold)).foregroundColor(MT.text).padding(.horizontal, 11).padding(.vertical, 5).background(MT.sunken, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// A flat strip across the top of a rounded card.
private struct UnevenCap: Shape {
    func path(in rect: CGRect) -> Path { Path(rect) }
}
