import SwiftUI
import UIKit

/// Messages as native screens inside the frame: the conversation list on the Messages tab, and the screens pushed from it.
/// It reads and writes the same Supabase data as the website (SupabaseAPI), so nothing on the server changes.
@MainActor
final class NativeMessages {
    static let shared = NativeMessages()

    /// On by default. Debug builds can switch it off with `-VVNativeMessages NO` to compare with the web version.
    nonisolated var isEnabled: Bool {
        #if DEBUG
        if UserDefaults.standard.object(forKey: "VVNativeMessages") != nil { return UserDefaults.standard.bool(forKey: "VVNativeMessages") }
        #endif
        return true
    }

    private let broker = SessionBroker()
    private weak var frame: FrameController?

    /// The person is signed in: keep a page open out of sight to hold the session, and start the list's data.
    func signedIn(frame: FrameController) {
        guard isEnabled else { return }
        self.frame = frame
        broker.start(in: frame.view)
        MessagesStore.shared.onUnreadChange = { [weak frame] count in frame?.setMessagesUnread(count) }
        MessagesStore.shared.activate()
    }

    func signedOut() {
        broker.stop()
        NativeSession.shared.clear()
        MessagesStore.shared.reset()
        frame = nil
    }

    // MARK: Screens

    /// The Messages tab's first screen.
    func makeList(navigator: Navigator) -> UIViewController {
        let store = MessagesStore.shared
        let controller = NativeScreenController(chrome: .band(title: "Messages"), navigator: navigator) {
            ConversationListHost(store: store, navigator: navigator)
        }
        controller.title = "Messages"
        return controller
    }

    /// The view controller that should present something new (the share sheet, a file preview).
    var topPresenter: UIViewController? { frame?.topPresenter }

    /// A conversation, pushed from the list or opened from a notification.
    func open(conversationId: String, in navigation: UINavigationController, navigator: Navigator) {
        if let top = navigation.topViewController as? NativeScreenController, top.subject == conversationId { return }
        let store = MessagesStore.shared
        let controller = NativeScreenController(chrome: .strip, navigator: navigator) {
            ThreadView(conversationId: conversationId, messagesStore: store,
                       onBack: { [weak navigation] in navigation?.popViewController(animated: true) },
                       onOpenURL: { [weak navigator] url in navigator?.open(url, from: nil) })
        }
        controller.hidesTabBar = true
        controller.subject = conversationId
        navigation.pushViewController(controller, animated: true)
    }
}

/// Glue between the list and the frame: opens conversations, the new-conversation sheet and the web fallback.
private struct ConversationListHost: View {
    @ObservedObject var store: MessagesStore
    let navigator: Navigator
    @State private var creating = false

    var body: some View {
        ConversationListView(
            store: store,
            onOpen: { open($0.id) },
            onNew: { creating = true },
            onOpenWeb: { navigator.open(webURL(), from: nil) })
        .task { store.activate() }
        .sheet(isPresented: $creating) {
            NewConversationView(store: store, onOpen: { id in creating = false; open(id) }, onClose: { creating = false })
        }
    }

    private func open(_ id: String) {
        guard let navigation = navigator.currentNavigation else { return }
        NativeMessages.shared.open(conversationId: id, in: navigation, navigator: navigator)
    }

    private func webURL() -> URL {
        var components = URLComponents(url: FrameConfig.url(forPath: "/family-village/messages"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "web", value: "1")]
        return components.url!
    }
}
