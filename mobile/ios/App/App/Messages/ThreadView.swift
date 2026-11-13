import SwiftUI
import UIKit

private struct BottomKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// A conversation: the wash header, the messages in runs with day pills, cards for News and system messages, the composer.
/// The web's thread (app/family-village/messages/thread.tsx) as a native screen.
struct ThreadView: View {
    let conversationId: String
    @ObservedObject var messagesStore: MessagesStore
    @StateObject private var store: ThreadStore
    var onBack: () -> Void
    var onOpenURL: (URL) -> Void

    @State private var activeId: String?
    @State private var draft = ""
    @State private var stashedDraft = ""
    @State private var replyingTo: MessageRow?
    @State private var editing: MessageRow?
    @State private var mentionIds: [String: String] = [:]
    @State private var emojiOpen = false
    @State private var busy = false
    @State private var nearBottom = true
    @State private var viewport: CGFloat = 0
    @State private var showDetails = false
    @State private var reporting: MessageRow?
    @State private var reactionsFor: String?
    @State private var seenFor: String?
    @State private var viewer: PhotoSet?
    @State private var confirmRemove: MessageRow?
    @FocusState private var focused: Bool
    @Environment(\.scenePhase) private var scenePhase

    init(conversationId: String, messagesStore: MessagesStore, onBack: @escaping () -> Void, onOpenURL: @escaping (URL) -> Void) {
        self.conversationId = conversationId
        self.messagesStore = messagesStore
        _store = StateObject(wrappedValue: ThreadStore(conversationId: conversationId))
        self.onBack = onBack
        self.onOpenURL = onOpenURL
    }

    private var conversation: ConversationRow? { messagesStore.conversation(conversationId) }
    private var userId: String { messagesStore.userId }
    private var roles: [String] { messagesStore.roles }

    var body: some View {
        Group {
            if let conversation { content(conversation) } else { placeholder }
        }
        .background(MT.surface.ignoresSafeArea())
        .task { await load() }
    }

    private func load() async {
        // Opened from a notification before the list has loaded: wait for the conversation to be known.
        if conversation == nil { await messagesStore.refresh() }
        guard let conversation else { return }
        await store.open(childThread: conversation.childThread)
        await store.loadSeenCounts(allowed: seenAllowed(conversation))
    }

    private var placeholder: some View {
        VStack(spacing: 12) {
            HStack { backButton; Spacer() }.padding(.horizontal, 8).padding(.top, 8)
            Spacer()
            if case .failed(let message) = messagesStore.phase { Text(message).font(.subheadline).foregroundColor(MT.muted) }
            else if messagesStore.phase == .ready { Text("This conversation is not available.").font(.headline).foregroundColor(MT.text) }
            else { ProgressView() }
            Spacer()
        }
    }

    private var backButton: some View {
        Button(action: onBack) {
            Image(systemName: "chevron.backward").font(.system(size: 19, weight: .semibold)).foregroundColor(MT.text).frame(width: 44, height: 44)
        }
        .accessibilityLabel("Back to conversations")
    }

    private func seenAllowed(_ conversation: ConversationRow) -> Bool {
        conversation.isChannel && (roles.contains("admin") || roles.contains("teacher") || conversation.createdBy == userId)
    }

    // MARK: Layout

    private func content(_ conversation: ConversationRow) -> some View {
        let blocked = conversation.postingBlock(roles: roles)
        return VStack(spacing: 0) {
            header(conversation)
            if conversation.childThread { childNote }
            messageList(conversation, blocked: blocked)
            if let blocked {
                Text(blocked).font(.subheadline).foregroundColor(MT.text).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16).background(MT.sunken, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .padding(.horizontal, 12).padding(.vertical, 10).background(MT.surface)
            } else {
                composer(conversation)
            }
        }
        .sheet(isPresented: $showDetails) {
            ConversationDetailsView(conversation: conversation, store: store, messages: messagesStore, onClose: { showDetails = false }, onLeft: { showDetails = false; onBack() })
        }
        .sheet(item: $reporting) { message in
            ReportSheet(onSend: { reason in
                let ok = await store.report(message, reason: reason)
                if ok { reporting = nil; Haptics.play("success") }
            }, onCancel: { reporting = nil })
        }
        .sheet(item: Binding(get: { reactionsFor.map { IDBox(id: $0) } }, set: { reactionsFor = $0?.id })) { box in
            ReactionsSheet(reactions: store.reactions.filter { $0.messageId == box.id }, people: store.people, me: userId)
        }
        .sheet(item: Binding(get: { seenFor.map { IDBox(id: $0) } }, set: { seenFor = $0?.id })) { box in
            SeenBySheet(load: { try await store.seenBy(box.id) })
        }
        .fullScreenCover(item: $viewer) { set in PhotoViewer(set: set) }
        .alert("Remove this message for everyone?", isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } })) {
            Button("Remove", role: .destructive) { if let message = confirmRemove { Task { await store.remove(message); Haptics.play("success") } } }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Messages", isPresented: Binding(get: { store.status != nil }, set: { if !$0 { store.status = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(store.status ?? "") }
        .onChange(of: messagesStore.tick) { _ in
            Task { await store.refresh(markRead: scenePhase == .active, seenAllowed: seenAllowed(conversation)) }
        }
    }

    // MARK: Header

    private func header(_ conversation: ConversationRow) -> some View {
        let tone = conversation.tone
        let flavour = conversation.flavour.label
        let topic = [conversation.isChannel ? (conversation.topic ?? "\(conversation.memberCount) people") : conversation.kind == .direct ? "" : "\(conversation.memberCount) people",
                     conversation.muted ? "Muted" : ""].filter { !$0.isEmpty }.joined(separator: " · ")
        return HStack(spacing: 8) {
            backButton
            ConversationAvatar(conversation: conversation, size: 44)
            VStack(alignment: .leading, spacing: 1) {
                if !flavour.isEmpty { Text(flavour.uppercased()).font(.system(size: 10.5, weight: .bold)).tracking(1).foregroundColor(MT.name(tone)) }
                Text(conversation.isChannel ? "# \(conversation.displayTitle)" : conversation.displayTitle).font(MT.serif(.title3)).foregroundColor(MT.text).lineLimit(1)
                if !topic.isEmpty { Text(topic).font(.caption).foregroundColor(MT.name(tone)).lineLimit(1) }
            }
            Spacer(minLength: 4)
            Button { showDetails = true } label: {
                Image(systemName: "ellipsis").font(.system(size: 20, weight: .bold)).foregroundColor(MT.text).frame(width: 44, height: 44)
            }
            .accessibilityLabel("Conversation details")
        }
        .padding(.leading, 4).padding(.trailing, 6).padding(.top, 8).padding(.bottom, 8)
        .background(LinearGradient(colors: [MT.wash(tone), MT.surface], startPoint: .leading, endPoint: UnitPoint(x: 0.82, y: 0.5)))
        .overlay(alignment: .top) { MT.fill(tone).frame(height: 4) }
        .overlay(alignment: .bottom) { MT.line.frame(height: 1) }
    }

    private var childNote: some View {
        let others = store.people.values.filter { $0.userId != userId }.map(\.displayName).sorted()
        var text = others.isEmpty ? "No one else is in this conversation right now." : "Messages here go to \(joinNames(others))."
        if !store.notInPortal.isEmpty { text += " \(joinNames(store.notInPortal)) \(store.notInPortal.count == 1 ? "is" : "are") not in the portal yet." }
        return Text(text).font(.footnote).foregroundColor(MT.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 6)
    }

    // MARK: Messages

    private func env(_ conversation: ConversationRow, blocked: String?, width: CGFloat) -> ThreadEnv {
        var env = ThreadEnv(userId: userId, conversation: conversation, people: store.people, roles: roles, blocked: blocked != nil,
                            maxBubble: max(180, width * 0.8), seenAllowed: seenAllowed(conversation), seenCounts: store.seenCounts,
                            reactions: store.reactions, attachments: store.attachments, activeId: activeId)
        env.toggle = { id in withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { activeId = activeId == id ? nil : id }; Haptics.play("selection") }
        env.react = { id, emoji in
            activeId = nil; Haptics.play("light")
            Task { await store.react(id, emoji, me: userId) }
        }
        env.reply = { message in activeId = nil; editing = nil; replyingTo = message; focused = true }
        env.edit = { message in
            activeId = nil; replyingTo = nil
            if editing == nil { stashedDraft = draft }
            editing = message; draft = message.body ?? ""; focused = true
        }
        env.remove = { message in activeId = nil; confirmRemove = message }
        env.report = { message in activeId = nil; reporting = message }
        env.copy = { message in UIPasteboard.general.string = message.body; Haptics.play("success") }
        env.whoReacted = { id in reactionsFor = id }
        env.seenBy = { id in seenFor = id }
        env.photos = { paths, index in viewer = PhotoSet(paths: paths, index: index) }
        env.file = { file in Task { await FilePreview.open(file) } }
        env.open = { url in onOpenURL(url) }
        return env
    }

    private func messageList(_ conversation: ConversationRow, blocked: String?) -> some View {
        GeometryReader { geometry in
            let items = ThreadItem.build(store.messages)
            let environment = env(conversation, blocked: blocked, width: geometry.size.width)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if store.hasMore {
                            Button("Earlier messages") {
                                let first = store.messages.first?.id
                                Task { await store.loadEarlier(); if let first { proxy.scrollTo(first, anchor: .top) } }
                            }
                            .font(.subheadline.weight(.semibold)).foregroundColor(MT.accentText).padding(.vertical, 10)
                        }
                        if store.loaded && items.isEmpty {
                            VStack(spacing: 10) {
                                Image(systemName: "bubble.left").font(.system(size: 28)).foregroundColor(MT.dangerText)
                                    .frame(width: 68, height: 68).background(MT.warmTint, in: Circle())
                                Text("Say hello.").foregroundColor(MT.muted)
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 48)
                        }
                        if !store.loaded {
                            if let failure = store.loadFailure { Text(failure).font(.subheadline).foregroundColor(MT.muted).padding(40) } else { ProgressView().padding(40) }
                        }
                        ForEach(items) { item in
                            MessageRowView(item: item, env: ThreadEnv.with(environment, jump: { id in
                                withAnimation { proxy.scrollTo(id, anchor: .center) }
                            }))
                        }
                        Color.clear.frame(height: 1).id("bottom")
                            .background(GeometryReader { g in Color.clear.preference(key: BottomKey.self, value: g.frame(in: .named("thread")).maxY) })
                    }
                    .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 12)
                }
                .coordinateSpace(name: "thread")
                .scrollDismissesKeyboard(.interactively)
                .onPreferenceChange(BottomKey.self) { y in nearBottom = y < geometry.size.height + 90 }
                .onAppear { viewport = geometry.size.height }
                .onChange(of: store.loaded) { loaded in if loaded { scrollToBottom(proxy, animated: false, settle: true) } }
                .onChange(of: store.newestStamp) { _ in if nearBottom || store.loaded { if nearBottom { scrollToBottom(proxy, animated: !reduceMotion, settle: false) } } }
                .onChange(of: focused) { isFocused in if isFocused { emojiOpen = false; scrollToBottom(proxy, animated: false, settle: true) } }
                .onChange(of: emojiOpen) { open in if open { scrollToBottom(proxy, animated: false, settle: true) } }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                    if nearBottom { scrollToBottom(proxy, animated: false, settle: true) }
                }
                .contentShape(Rectangle())
                .onTapGesture { activeId = nil; focused = false }
            }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool, settle: Bool) {
        let go = { if animated { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } } else { proxy.scrollTo("bottom", anchor: .bottom) } }
        DispatchQueue.main.async(execute: go)
        // Rows are measured as they are first drawn, so a second pass catches what the first one missed.
        if settle { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: go) }
    }

    // MARK: Composer

    private var mentionMatches: [Person] {
        guard let conversation, conversation.kind != .direct, editing == nil else { return [] }
        guard let range = draft.range(of: "(?:^|\\s)@([^\\s@]{0,30})$", options: .regularExpression) else { return [] }
        let token = draft[range].drop(while: { $0.isWhitespace }).dropFirst().lowercased()
        return Array(store.people.values.filter { $0.userId != userId && (token.isEmpty || $0.displayName.lowercased().contains(token)) }
            .sorted { $0.displayName < $1.displayName }.prefix(5))
    }

    private func composer(_ conversation: ConversationRow) -> some View {
        ComposerView(
            draft: $draft,
            replyingTo: replyingTo.map { (store.people[$0.senderId ?? ""].map { $0.userId == userId ? "yourself" : $0.displayName } ?? "Former member", MessageRow.snippet(body: $0.body, imagePath: $0.imagePath, deletedAt: $0.deletedAt, max: 60)) },
            editing: editing != nil, mentionMatches: mentionMatches, busy: busy, emojiOpen: $emojiOpen, focus: $focused,
            onCancelContext: {
                if editing != nil { draft = stashedDraft; editing = nil } else { replyingTo = nil }
            },
            onPickMention: { person in
                if let range = draft.range(of: "@[^\\s@]{0,30}$", options: .regularExpression) {
                    draft.replaceSubrange(range, with: "@\(person.displayName) ")
                    mentionIds[person.displayName] = person.userId
                }
            },
            onSend: { send() })
    }

    private func send() {
        guard !busy else { return }
        let body = draft
        busy = true
        Task {
            var ok = false
            if let message = editing {
                ok = await store.edit(message, to: body.trimmingCharacters(in: .whitespacesAndNewlines))
                if ok { draft = stashedDraft; editing = nil }
            } else {
                let mentions = mentionIds.filter { body.contains("@\($0.key)") }.map(\.value)
                ok = await store.send(body: body, replyTo: replyingTo?.id, mentions: mentions)
                if ok { draft = ""; replyingTo = nil; mentionIds = [:] }
            }
            busy = false
            emojiOpen = false
            Haptics.play(ok ? "light" : "error")
        }
    }
}

extension ThreadEnv {
    static func with(_ env: ThreadEnv, jump: @escaping (String) -> Void) -> ThreadEnv {
        var copy = env
        copy.jumpTo = jump
        return copy
    }
}

struct IDBox: Identifiable { let id: String }
