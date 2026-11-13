import SwiftUI

/// The conversation list: Channels, Messages and Archived, unread dots and counts, a muted icon, built-in channels first
/// (the web's list, app/family-village/messages/messages-app.tsx, as a native list with swipe actions and a context menu).
struct ConversationListView: View {
    @ObservedObject var store: MessagesStore
    var onOpen: (ConversationRow) -> Void
    var onNew: () -> Void
    var onOpenWeb: () -> Void

    @State private var archivedOpen = false
    @State private var confirmBlock: ConversationRow?
    @State private var confirmLeave: ConversationRow?
    @State private var problem: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            content
        }
        .background(MT.surface.ignoresSafeArea())
        .alert("Block \(confirmBlock?.displayTitle ?? "")?", isPresented: Binding(get: { confirmBlock != nil }, set: { if !$0 { confirmBlock = nil } }), presenting: confirmBlock) { row in
            Button("Block", role: .destructive) { run { try await store.block(row.otherUserId ?? "") } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in Text("They won't be able to message you, and you won't see their messages.") }
        .alert("Leave \(confirmLeave?.displayTitle ?? "")?", isPresented: Binding(get: { confirmLeave != nil }, set: { if !$0 { confirmLeave = nil } }), presenting: confirmLeave) { row in
            Button("Leave", role: .destructive) { run { try await store.leave(row) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in Text("You will stop receiving its messages.") }
        .alert("Messages", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(problem ?? "") }
    }

    private func run(_ work: @escaping () async throws -> Void) {
        Task {
            do { try await work(); Haptics.play("success") } catch { problem = error.localizedDescription; Haptics.play("error") }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack {
            Text("Conversations").font(MT.serif(.title2)).foregroundColor(MT.text).accessibilityAddTraits(.isHeader)
            Spacer()
            Button(action: { Haptics.play("light"); onNew() }) {
                Label("New", systemImage: "plus").font(.subheadline.weight(.semibold))
                    .padding(.vertical, 9).padding(.leading, 12).padding(.trailing, 16)
                    .foregroundColor(Color(MT.cream)).background(MT.action, in: Capsule())
            }
            .accessibilityLabel("New message")
        }
        .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 8)
        .background(MT.surface)
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        switch store.phase {
        case .loading where store.conversations.isEmpty:
            VStack { Spacer(); ProgressView(); Spacer() }.frame(maxWidth: .infinity)
        case .failed(let message) where store.conversations.isEmpty:
            VStack(spacing: 12) {
                Spacer()
                Text("Messages could not load").font(MT.serif(.title3)).foregroundColor(MT.text)
                Text(message).font(.subheadline).foregroundColor(MT.muted).multilineTextAlignment(.center)
                Button("Try again") { store.retry() }.buttonStyle(.borderedProminent).tint(MT.action)
                Button("Use the web version", action: onOpenWeb).font(.subheadline).foregroundColor(MT.accentText)
                Spacer()
            }
            .padding(.horizontal, 32).frame(maxWidth: .infinity)
        default:
            list
        }
    }

    private var live: [ConversationRow] { store.conversations.filter { !$0.isArchived } }
    private var channels: [ConversationRow] {
        // Built-in channels first, then the rest in the order the database gave (most recent activity first).
        let rows = live.filter(\.isChannel)
        return rows.filter(\.isBuiltIn) + rows.filter { !$0.isBuiltIn }
    }
    private var chats: [ConversationRow] { live.filter { !$0.isChannel } }
    private var archived: [ConversationRow] { store.conversations.filter(\.isArchived) }

    private var list: some View {
        List {
            if store.conversations.isEmpty {
                Text("Nothing here yet. Choose New to message a teacher or another family.")
                    .font(.subheadline).foregroundColor(MT.muted).padding(.horizontal, 22).padding(.vertical, 24)
                    .plainRow()
            }
            section("Channels", channels)
            section("Messages", chats)
            if !archived.isEmpty {
                Button { withAnimation(reduceMotion ? nil : .default) { archivedOpen.toggle() } } label: {
                    HStack {
                        sectionTitle("Archived (\(archived.count))")
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundColor(MT.muted)
                            .rotationEffect(.degrees(archivedOpen ? 90 : 0)).padding(.trailing, 18)
                    }
                }
                .buttonStyle(.plain).plainRow()
                .accessibilityLabel("Archived, \(archived.count) conversations").accessibilityHint(archivedOpen ? "Collapses the list" : "Shows the list")
                if archivedOpen { ForEach(archived) { row($0) } }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await store.refresh(); Haptics.play("selection") }
    }

    @ViewBuilder private func section(_ title: String, _ rows: [ConversationRow]) -> some View {
        if !rows.isEmpty {
            sectionTitle(title).plainRow().accessibilityAddTraits(.isHeader)
            ForEach(rows) { row($0) }
        }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text.uppercased()).font(.caption2.weight(.bold)).tracking(1.0).foregroundColor(MT.muted)
            .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 6)
    }

    // MARK: Row

    private func row(_ conversation: ConversationRow) -> some View {
        Button { Haptics.play("selection"); onOpen(conversation) } label: { ConversationRowView(conversation: conversation) }
            .buttonStyle(RowPressStyle())
            .plainRow()
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if store.canLeave(conversation) { Button(role: .destructive) { confirmLeave = conversation } label: { Label("Leave", systemImage: "rectangle.portrait.and.arrow.right") } }
                if conversation.kind == .direct, conversation.otherUserId != nil { Button(role: .destructive) { confirmBlock = conversation } label: { Label("Block", systemImage: "hand.raised") } }
                Button { toggleMute(conversation) } label: { Label(conversation.muted ? "Unmute" : "Mute", systemImage: conversation.muted ? "bell" : "bell.slash") }.tint(MT.fill(5))
            }
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                if conversation.unreadCount > 0 { Button { Task { await store.markRead(conversation.id); Haptics.play("selection") } } label: { Label("Read", systemImage: "checkmark.message") }.tint(MT.fill(3)) }
            }
            .contextMenu {
                if conversation.unreadCount > 0 { Button { Task { await store.markRead(conversation.id) } } label: { Label("Mark as read", systemImage: "checkmark.message") } }
                Button { toggleMute(conversation) } label: { Label(conversation.muted ? "Unmute" : "Mute", systemImage: conversation.muted ? "bell" : "bell.slash") }
                if store.canLeave(conversation) { Button(role: .destructive) { confirmLeave = conversation } label: { Label("Leave", systemImage: "rectangle.portrait.and.arrow.right") } }
                if conversation.kind == .direct, conversation.otherUserId != nil { Button(role: .destructive) { confirmBlock = conversation } label: { Label("Block", systemImage: "hand.raised") } }
            }
    }

    private func toggleMute(_ conversation: ConversationRow) {
        run { try await store.setMuted(conversation, !conversation.muted) }
    }
}

/// Rows highlight while pressed, like a native list.
private struct RowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? MT.sunken : MT.surface)
    }
}

struct ConversationRowView: View {
    let conversation: ConversationRow

    private var unread: Bool { conversation.unreadCount > 0 && !conversation.muted && !conversation.isArchived }
    private var title: String { conversation.isChannel ? "# \(conversation.displayTitle)" : conversation.displayTitle }
    private var preview: String {
        guard let last = conversation.lastPreview, !last.isEmpty else { return conversation.topic ?? "No messages yet" }
        if conversation.kind != .direct, let name = conversation.lastSenderName, !name.isEmpty { return "\(name): \(last)" }
        return last
    }

    var body: some View {
        HStack(spacing: 13) {
            ConversationAvatar(conversation: conversation)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.body.weight(unread ? .bold : .medium)).foregroundColor(MT.text).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(MessageDates.shortTime(conversation.lastMessageAt)).font(.caption.weight(unread ? .bold : .regular))
                        .foregroundColor(unread ? MT.accentText : MT.muted).lineLimit(1)
                }
                HStack(spacing: 8) {
                    Text(preview).font(.subheadline.weight(unread ? .medium : .regular)).foregroundColor(unread ? MT.text : MT.muted).lineLimit(1)
                    Spacer(minLength: 0)
                    if conversation.muted { Image(systemName: "bell.slash").font(.footnote).foregroundColor(MT.muted).accessibilityLabel("Muted") }
                    if unread {
                        Text("\(conversation.unreadCount)").font(.caption.weight(.bold)).foregroundColor(Color(MT.cream))
                            .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20).background(MT.terracotta, in: Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 11).padding(.leading, 24).padding(.trailing, 16)
        .overlay(alignment: .leading) {
            if unread { Circle().fill(MT.terracotta).frame(width: 9, height: 9).padding(.leading, 8) }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title)\(unread ? ", \(conversation.unreadCount) unread" : "")\(conversation.muted ? ", muted" : ""). \(preview). \(MessageDates.shortTime(conversation.lastMessageAt))")
        .accessibilityAddTraits(.isButton)
    }
}
