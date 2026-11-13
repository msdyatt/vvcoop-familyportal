import SwiftUI

/// The pill field with the emoji button inside, and a terracotta send button (the web's composer). Above it, as needed: who you are
/// replying to or the message being edited, people to @mention, and the emoji panel.
struct ComposerView: View {
    @Binding var draft: String
    var replyingTo: (name: String, snippet: String)?
    var editing: Bool
    var mentionMatches: [Person]
    var busy: Bool
    var pending: [PendingAttachment] = []
    var canAttach = true
    var onPickPhotos: () -> Void = {}
    var onTakePhoto: () -> Void = {}
    var onPickFile: () -> Void = {}
    var onRemovePending: (PendingAttachment) -> Void = { _ in }
    @Binding var emojiOpen: Bool
    var focus: FocusState<Bool>.Binding
    var onCancelContext: () -> Void
    var onPickMention: (Person) -> Void
    var onSend: () -> Void

    @State private var emojiGroup = emojiGroups[0].id

    private var canSend: Bool { (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pending.isEmpty) && !busy }

    var body: some View {
        VStack(spacing: 0) {
            if !mentionMatches.isEmpty { mentions }
            if replyingTo != nil || editing { context }
            if !pending.isEmpty && !editing { PendingStrip(items: pending, onRemove: onRemovePending) }
            HStack(alignment: .bottom, spacing: 8) {
                if !editing { plusButton }
                field
                Button(action: onSend) {
                    Image(systemName: "arrow.up").font(.system(size: 18, weight: .bold)).foregroundColor(Color(MT.cream))
                        .frame(width: 42, height: 42).background(Circle().fill(MT.terracotta))
                        .opacity(canSend ? 1 : 0.38)
                }
                .disabled(!canSend)
                .accessibilityLabel(busy ? "Sending" : editing ? "Save" : "Send")
            }
            .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 10)
            if emojiOpen { emojiPanel }
        }
        .background(MT.surface.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { MT.line.frame(height: 1) }
    }

    /// Photos and files, from the library, the camera or Files.
    private var plusButton: some View {
        Menu {
            Button(action: onPickPhotos) { Label("Photo Library", systemImage: "photo.on.rectangle") }
            if CameraPicker.isAvailable { Button(action: onTakePhoto) { Label("Take Photo", systemImage: "camera") } }
            Button(action: onPickFile) { Label("Choose File", systemImage: "doc") }
        } label: {
            Image(systemName: "plus").font(.system(size: 19, weight: .semibold)).foregroundColor(MT.text)
                .frame(width: 42, height: 42).background(Circle().fill(MT.sunken))
        }
        .disabled(busy || !canAttach)
        .accessibilityLabel("Add photos or files")
    }

    private var field: some View {
        HStack(alignment: .bottom, spacing: 0) {
            TextField(editing ? "Edit your message" : "Write a message", text: $draft, axis: .vertical)
                .lineLimit(1...5).focused(focus).font(.body)
                .padding(.leading, 16).padding(.trailing, 4).padding(.vertical, 9)
                .disabled(busy)
                .accessibilityLabel("Message")
            Button {
                emojiOpen.toggle()
                if emojiOpen { focus.wrappedValue = false } else { focus.wrappedValue = true }
            } label: {
                Image(systemName: emojiOpen ? "keyboard" : "face.smiling").font(.system(size: 21)).foregroundColor(emojiOpen ? MT.accentText : MT.muted)
                    .frame(width: 40, height: 40)
            }
            .accessibilityLabel(emojiOpen ? "Keyboard" : "Emoji")
        }
        .background(MT.sunken, in: RoundedRectangle(cornerRadius: 23, style: .continuous))
    }

    private var context: some View {
        HStack(spacing: 8) {
            Image(systemName: editing ? "pencil" : "arrowshape.turn.up.left").foregroundColor(MT.dangerText)
            Group {
                if editing { Text("Editing message").bold() } else if let replyingTo { Text("Replying to ") + Text(replyingTo.name).bold() + Text(": \(replyingTo.snippet)") }
            }
            .font(.footnote).foregroundColor(MT.dangerText).lineLimit(1)
            Spacer()
            Button(action: onCancelContext) { Image(systemName: "xmark").font(.footnote.weight(.bold)).foregroundColor(MT.dangerText).frame(width: 32, height: 32) }
                .accessibilityLabel(editing ? "Cancel edit" : "Cancel reply")
        }
        .padding(.leading, 16).padding(.trailing, 8).padding(.vertical, 4)
        .background(MT.warmTint)
        .overlay(alignment: .leading) { MT.terracotta.frame(width: 4) }
    }

    private var mentions: some View {
        VStack(spacing: 0) {
            ForEach(mentionMatches) { person in
                Button { onPickMention(person) } label: {
                    HStack(spacing: 10) {
                        AvatarView(label: person.displayName, path: person.avatarPath, tone: MessageTone.toneFor(person.userId), ring: person.ring, size: 28)
                        Text(person.displayName).font(.body).foregroundColor(MT.text)
                        Spacer()
                        if person.isTeacher { RoleTag(text: "Teacher", tone: MessageTone.toneFor(person.userId)) }
                        if person.isAdmin { RoleTag(text: "Admin", tone: MessageTone.toneFor(person.userId)) }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 4)
        .background(MT.surface)
    }

    private var emojiPanel: some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                ForEach(emojiGroups) { group in
                    Button { emojiGroup = group.id } label: {
                        Text(group.icon).font(.system(size: 20)).frame(width: 44, height: 38)
                            .background(emojiGroup == group.id ? MT.sunken : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(alignment: .bottom) { if emojiGroup == group.id { MT.terracotta.frame(height: 3) } }
                    }
                    .accessibilityLabel(group.label)
                }
            }
            .padding(.horizontal, 10).padding(.top, 6)
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 42), spacing: 0)], spacing: 0) {
                    ForEach((emojiGroups.first { $0.id == emojiGroup } ?? emojiGroups[0]).emoji, id: \.self) { emoji in
                        Button { draft += emoji } label: { Text(emoji).font(.system(size: 26)).frame(height: 42).frame(maxWidth: .infinity) }
                            .accessibilityLabel("Insert \(emoji)")
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
            }
            .frame(height: 190).background(MT.sunken)
        }
    }
}
