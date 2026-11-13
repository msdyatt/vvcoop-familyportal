import SwiftUI

/// A person's photo, or their initial on their own tint. Teachers get a gold ring, administrators a terracotta one.
struct AvatarView: View {
    let label: String
    var path: String?
    var tone: Int
    var ring: AvatarRing?
    var size: CGFloat = 46

    var body: some View {
        StoredImage(path: path) { initial }
            .frame(width: size, height: size)
            .clipShape(Circle())
            .overlay { if let ring { RingView(ring: ring) } }
            .accessibilityHidden(true)
    }

    private var initial: some View {
        ZStack {
            MT.fill(tone)
            Text(String(label.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
                .font(.system(size: size * 0.43, weight: .semibold))
                .foregroundColor(Color(MT.cream))
        }
    }
}

/// The role ring: a gap of surface colour, then a 2pt ring (web: .avatar-ring).
private struct RingView: View {
    let ring: AvatarRing
    var body: some View {
        ZStack {
            Circle().stroke(MT.surface, lineWidth: 2).padding(-1)
            Circle().stroke(ring == .admin ? MT.terracotta : MT.gold, lineWidth: 2).padding(-3)
        }
    }
}

/// The picture for a conversation: a person's photo (or initial) for a direct chat, otherwise a rounded tile in the colour of
/// its kind, with a mark that says which: # for a channel, a book for a class, two people for a group, a house for a family thread.
struct ConversationAvatar: View {
    let conversation: ConversationRow
    var size: CGFloat = 46

    var body: some View {
        switch conversation.flavour {
        case .direct:
            AvatarView(label: conversation.displayTitle, path: conversation.otherAvatarPath, tone: conversation.tone, size: size)
        default:
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).fill(MT.fill(conversation.tone))
                mark.foregroundColor(Color(MT.cream))
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
        }
    }

    @ViewBuilder private var mark: some View {
        switch conversation.flavour {
        case .channel: Text("#").font(.system(size: size * 0.46, weight: .bold, design: .serif))
        case .class: Image(systemName: "book").font(.system(size: size * 0.42, weight: .medium))
        case .family: Image(systemName: "house").font(.system(size: size * 0.42, weight: .medium))
        default: Image(systemName: "person.2").font(.system(size: size * 0.42, weight: .medium))
        }
    }
}
