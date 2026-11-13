import Foundation
import SwiftUI
import UIKit

/// One open conversation: its messages (newest page first, older on request), who is in it, reactions, photos and files, and
/// "seen by" for the people who may see it. The same reads and writes as the web thread (app/family-village/messages/thread.tsx).
@MainActor
final class ThreadStore: ObservableObject {
    let conversationId: String

    @Published private(set) var messages: [MessageRow] = []
    @Published private(set) var hasMore = false
    @Published private(set) var people: [String: Person] = [:]
    @Published private(set) var reactions: [Reaction] = []
    @Published private(set) var attachments: [String: [Attachment]] = [:]
    @Published private(set) var seenCounts: [String: SeenCount] = [:]
    @Published private(set) var notInPortal: [String] = []
    @Published private(set) var loaded = false
    @Published private(set) var loadFailure: String?
    /// Bumped when the newest messages changed, so the view can scroll to them.
    @Published private(set) var newestStamp = 0
    @Published var status: String?

    private let page = 50
    private var seenOff = false
    private var loadingAttachments: Set<String> = []

    init(conversationId: String) { self.conversationId = conversationId }

    // MARK: Loading

    /// Opening a conversation: who is in it, the latest messages, mark it read.
    func open(childThread: Bool) async {
        do {
            let list: [Person] = try await SupabaseAPI.shared.rpc("conversation_people", ["p_conversation_id": conversationId])
            people = Dictionary(uniqueKeysWithValues: list.map { ($0.userId, $0) })
            await SignedURLCache.shared.prefetch(list.compactMap(\.avatarPath))
            if childThread, let missing: [String] = try? await SupabaseAPI.shared.rpc("child_thread_not_in_portal", ["p_conversation_id": conversationId]) {
                notInPortal = missing
            }
            try await fetchLatest()
            loaded = true
            loadFailure = nil
            await markRead()
        } catch {
            if !loaded { loadFailure = error.localizedDescription }
        }
    }

    func fetchLatest() async throws {
        let rows: [MessageRow] = try await SupabaseAPI.shared.select("messages", [
            URLQueryItem(name: "select", value: MessageRow.columns),
            URLQueryItem(name: "conversation_id", value: "eq.\(conversationId)"),
            URLQueryItem(name: "order", value: "created_at.desc"),
            URLQueryItem(name: "limit", value: "\(page)"),
        ])
        let latest = Array(rows.reversed())
        // Keep anything older that was already loaded; replace the newest page.
        let kept = latest.first.map { oldest in messages.filter { $0.createdAt < oldest.createdAt } } ?? []
        let merged = kept + latest
        let changedTail = merged.last?.id != messages.last?.id || merged.count != messages.count
        if merged != messages { messages = merged }
        hasMore = rows.count == page || (hasMore && kept.count > 0)
        if changedTail { newestStamp += 1 }
        await loadAround()
    }

    func loadEarlier() async {
        guard let oldest = messages.first?.createdAt else { return }
        guard let rows: [MessageRow] = try? await SupabaseAPI.shared.select("messages", [
            URLQueryItem(name: "select", value: MessageRow.columns),
            URLQueryItem(name: "conversation_id", value: "eq.\(conversationId)"),
            URLQueryItem(name: "created_at", value: "lt.\(oldest)"),
            URLQueryItem(name: "order", value: "created_at.desc"),
            URLQueryItem(name: "limit", value: "\(page)"),
        ]) else { return }
        messages = rows.reversed() + messages
        hasMore = rows.count == page
        await loadAround()
    }

    /// Reactions, photos and files, and signed links for what is loaded.
    private func loadAround() async {
        await loadReactions()
        await loadAttachments()
    }

    func loadReactions() async {
        let ids = messages.map(\.id)
        guard !ids.isEmpty else { reactions = []; return }
        if let rows: [Reaction] = try? await SupabaseAPI.shared.select("message_reactions", [
            URLQueryItem(name: "select", value: "message_id,user_id,emoji"),
            URLQueryItem(name: "message_id", value: "in.(\(ids.joined(separator: ",")))"),
        ]) { if rows != reactions { reactions = rows } }
    }

    private func loadAttachments() async {
        let need = messages.filter { $0.hasAttachments && attachments[$0.id] == nil && !loadingAttachments.contains($0.id) }.map(\.id)
        if !need.isEmpty {
            loadingAttachments.formUnion(need)
            if let rows: [Attachment] = try? await SupabaseAPI.shared.select("message_attachments", [
                URLQueryItem(name: "select", value: "id,message_id,position,kind,path,name,mime,size_bytes"),
                URLQueryItem(name: "message_id", value: "in.(\(need.joined(separator: ",")))"),
                URLQueryItem(name: "order", value: "position"),
            ]) {
                var grouped = Dictionary(uniqueKeysWithValues: need.map { ($0, [Attachment]()) })
                for row in rows { grouped[row.messageId, default: []].append(row) }
                attachments.merge(grouped) { _, new in new }
            }
            loadingAttachments.subtract(need)
        }
        let paths = messages.compactMap(\.imagePath) + attachments.values.flatMap { $0.map(\.path) }
        await SignedURLCache.shared.prefetch(paths)
    }

    /// "Seen by" is for administrators, teachers and the person who made the channel, in channels and class chats only.
    func loadSeenCounts(allowed: Bool) async {
        guard allowed, !seenOff, !messages.isEmpty else { return }
        let ids = Array(messages.map(\.id).suffix(100))
        do {
            let rows: [SeenCount] = try await SupabaseAPI.shared.rpc("message_seen_counts", ["p_conversation_id": conversationId, "p_message_ids": ids])
            seenCounts = Dictionary(uniqueKeysWithValues: rows.map { ($0.messageId, $0) })
        } catch {
            // Someone the database does not count as staff just does not get the feature.
            seenOff = true
        }
    }

    func seenBy(_ messageId: String) async throws -> [SeenPerson] {
        let rows: [SeenPerson] = try await SupabaseAPI.shared.rpc("message_seen_by", ["p_message_id": messageId])
        await SignedURLCache.shared.prefetch(rows.compactMap(\.avatarPath))
        return rows
    }

    func markRead() async {
        try? await SupabaseAPI.shared.call("mark_conversation_read", ["p_conversation_id": conversationId])
        await MessagesStore.shared.refresh()
    }

    /// A live event or the poll: look again.
    func refresh(markRead read: Bool, seenAllowed: Bool) async {
        try? await fetchLatest()
        if read { await markRead() }
        await loadSeenCounts(allowed: seenAllowed)
    }

    func refreshPeople() async {
        if let list: [Person] = try? await SupabaseAPI.shared.rpc("conversation_people", ["p_conversation_id": conversationId]) {
            people = Dictionary(uniqueKeysWithValues: list.map { ($0.userId, $0) })
        }
    }

    // MARK: Writing

    /// Sends a message; returns true when it went. Mentions are the ids of people whose @name is still in the text.
    func send(body: String, replyTo: String?, mentions: [String]) async -> Bool {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        do {
            let _: String = try await SupabaseAPI.shared.rpc("send_message", [
                "p_conversation_id": conversationId, "p_body": text,
                "p_reply_to": replyTo.map { $0 as Any } ?? NSNull(), "p_mentions": mentions, "p_attachments": [Any](),
            ])
            try await fetchLatest()
            newestStamp += 1
            await MessagesStore.shared.refresh()
            return true
        } catch {
            status = error.localizedDescription
            return false
        }
    }

    func edit(_ message: MessageRow, to text: String) async -> Bool {
        do {
            try await SupabaseAPI.shared.call("edit_own_message", ["p_message_id": message.id, "p_body": text])
            try await fetchLatest()
            await MessagesStore.shared.refresh()
            return true
        } catch { status = error.localizedDescription; return false }
    }

    func remove(_ message: MessageRow) async {
        do {
            // The answer is one path, or several separated by new lines, for the files of the removed message.
            let paths: String? = try await SupabaseAPI.shared.rpc("delete_own_message", ["p_message_id": message.id])
            if let paths, !paths.isEmpty { await SupabaseAPI.shared.remove(paths.components(separatedBy: "\n")) }
            try await fetchLatest()
            await MessagesStore.shared.refresh()
        } catch { status = error.localizedDescription }
    }

    func react(_ messageId: String, _ emoji: String, me: String) async {
        // Show it at once; the server's answer replaces it.
        let mine = Reaction(messageId: messageId, userId: me, emoji: emoji)
        if reactions.contains(mine) { reactions.removeAll { $0 == mine } } else { reactions.append(mine) }
        do {
            try await SupabaseAPI.shared.call("toggle_reaction", ["p_message_id": messageId, "p_emoji": emoji])
        } catch { status = error.localizedDescription }
        await loadReactions()
    }

    func report(_ message: MessageRow, reason: String) async -> Bool {
        do {
            try await SupabaseAPI.shared.call("report_message", ["p_message_id": message.id, "p_reason": reason])
            status = "Thank you. An administrator will look at this message."
            return true
        } catch { status = error.localizedDescription; return false }
    }
}
