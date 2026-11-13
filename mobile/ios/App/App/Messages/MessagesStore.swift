import Combine
import Foundation
import UIKit

/// What the conversation list, the tab badge and the open thread share: the person's conversations, their roles and the
/// unread count, kept fresh by the live feed with a 30 second poll as the safety net (the same as the web).
@MainActor
final class MessagesStore: ObservableObject {
    static let shared = MessagesStore()

    enum Phase: Equatable { case loading, ready, failed(String) }

    @Published private(set) var conversations: [ConversationRow] = []
    @Published private(set) var phase: Phase = .loading
    @Published private(set) var roles: [String] = []
    @Published private(set) var canCreateChannel = false
    /// Bumped on every live event and poll, so an open thread knows to look again.
    @Published private(set) var tick = 0
    /// Unread messages for the tab badge; nil until first known.
    @Published private(set) var unread: Int?

    var userId: String { NativeSession.shared.info?.userId ?? "" }
    var isStaff: Bool { roles.contains("admin") || roles.contains("teacher") }

    private let live = LiveFeed()
    private var poll: Timer?
    private var active = false
    private var observers: [NSObjectProtocol] = []
    private var changeDebounce: Task<Void, Never>?
    private var retryScheduled = false

    // MARK: Lifecycle

    /// Starts keeping the list fresh. Safe to call again.
    func activate() {
        guard !active else { return }
        active = true
        NativeSession.shared.onUserChange = { [weak self] user in
            Task { @MainActor in
                guard let self else { return }
                if user == nil { self.reset() } else { self.reset(); self.activate(); }
            }
        }
        live.onChange = { [weak self] in self?.liveEventArrived() }
        live.start()
        poll = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick += 1; await self?.refresh() }
        }
        observers = [
            NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.live.reconnectNow(); await self?.refresh() }
            },
        ]
        Task { await refresh(); await loadSecondary() }
    }

    /// Signed out: forget everything.
    func reset() {
        active = false
        live.stop()
        poll?.invalidate(); poll = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        conversations = []
        roles = []
        canCreateChannel = false
        unread = nil
        phase = .loading
        SignedURLCache.shared.clear()
        PictureCache.shared.clear()
        onUnreadChange?(nil)
    }

    /// The frame's tab badge.
    var onUnreadChange: ((Int?) -> Void)?

    private func liveEventArrived() {
        changeDebounce?.cancel()
        changeDebounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            self?.tick += 1
            await self?.refresh()
        }
    }

    // MARK: Loading

    func refresh() async {
        do {
            let rows: [ConversationRow] = try await SupabaseAPI.shared.rpc("my_conversations")
            conversations = rows
            phase = .ready
            await SignedURLCache.shared.prefetch(rows.compactMap(\.otherAvatarPath))
        } catch is CancellationError {
            return
        } catch {
            // A refresh that fails keeps what is on screen; only a first load shows the failure.
            if conversations.isEmpty {
                phase = .failed(error.localizedDescription)
                // The page that hands over the session may simply not have answered yet: look again shortly.
                if !retryScheduled {
                    retryScheduled = true
                    Task { try? await Task.sleep(nanoseconds: 4_000_000_000); self.retryScheduled = false; if self.active, self.conversations.isEmpty { await self.refresh() } }
                }
            }
        }
        await refreshUnread()
    }

    func refreshUnread() async {
        guard let count: Int = try? await SupabaseAPI.shared.rpc("unread_message_count") else { return }
        if unread != count { unread = count; onUnreadChange?(count) }
    }

    private func loadSecondary() async {
        if let rows: [RoleRow] = try? await SupabaseAPI.shared.select("user_roles", [
            URLQueryItem(name: "select", value: "role"), URLQueryItem(name: "user_id", value: "eq.\(userId)")]) {
            roles = rows.map(\.role)
        }
        if let allowed: Bool = try? await SupabaseAPI.shared.rpc("can_create_channels") { canCreateChannel = allowed }
    }
    private struct RoleRow: Decodable { let role: String }

    func retry() {
        phase = .loading
        Task { await refresh(); await loadSecondary() }
    }

    // MARK: Actions on a conversation

    func conversation(_ id: String) -> ConversationRow? { conversations.first { $0.id == id } }

    func markRead(_ id: String) async {
        try? await SupabaseAPI.shared.call("mark_conversation_read", ["p_conversation_id": id])
        if let index = conversations.firstIndex(where: { $0.id == id }) { conversations[index].unreadCount = 0 }
        await refreshUnread()
    }

    func setMuted(_ conversation: ConversationRow, _ muted: Bool) async throws {
        try await SupabaseAPI.shared.call("set_conversation_muted", ["p_conversation_id": conversation.id, "p_muted": muted])
        if let index = conversations.firstIndex(where: { $0.id == conversation.id }) { conversations[index].muted = muted }
        await refresh()
    }

    func leave(_ conversation: ConversationRow) async throws {
        try await SupabaseAPI.shared.call("leave_conversation", ["p_conversation_id": conversation.id])
        conversations.removeAll { $0.id == conversation.id }
        await refresh()
    }

    func block(_ otherUserId: String) async throws {
        try await SupabaseAPI.shared.call("block_user", ["p_user": otherUserId])
        await refresh()
    }

    /// Whether a person may leave: groups, and channels people were invited to (not class chats or built-in ones for everyone).
    func canLeave(_ conversation: ConversationRow) -> Bool {
        (conversation.kind == .group) || (conversation.kind == .channel && conversation.audience == "invite")
    }
}
