import Foundation
import WebKit

/// The signed-in person's session, for the native screens.
///
/// The website is the only place that signs in and refreshes (lib/native-session.ts): a refresh token can be used once,
/// so a second holder in the app would sign the web session out. The page hands over the short-lived access token with
/// `VVNative.post("session", ...)`; the frame keeps it in memory only. When it is about to run out, or the server turns it
/// down, `validSession()` asks a page to refresh (`session.refresh`) and waits for the answer.
final class NativeSession {
    static let shared = NativeSession()

    struct Info: Equatable {
        let url: URL
        let key: String
        let userId: String
        let accessToken: String
        let expiresAt: Date
    }

    enum Failure: Error, LocalizedError {
        case notSignedIn
        var errorDescription: String? { "Please sign in again." }
    }

    private(set) var info: Info?
    /// Somebody else signed in, or nobody is signed in any more (nil): screens drop what they hold.
    var onUserChange: ((String?) -> Void)?
    /// Asks a page for a new token. Set by `SessionBroker`.
    var requestRefresh: ((_ force: Bool) -> Void)?
    private var waiting: [CheckedContinuation<Info, Error>] = []
    private var refreshAsked: Date?

    /// A `session` message from a page.
    func update(from payload: [String: Any]) {
        guard (payload["signedIn"] as? Bool) == true,
              let urlText = payload["url"] as? String, let url = URL(string: urlText),
              let key = payload["key"] as? String, let userId = payload["userId"] as? String,
              let token = payload["accessToken"] as? String else {
            clear()
            return
        }
        let expiry = (payload["expiresAt"] as? Double) ?? (payload["expiresAt"] as? Int).map(Double.init) ?? Date().timeIntervalSince1970 + 3000
        let next = Info(url: url, key: key, userId: userId, accessToken: token, expiresAt: Date(timeIntervalSince1970: expiry))
        let previousUser = info?.userId
        // An older token arriving after a newer one (two pages answering) is ignored.
        if let current = info, current.userId == userId, current.expiresAt > next.expiresAt { return }
        info = next
        refreshAsked = nil
        let pending = waiting
        waiting = []
        pending.forEach { $0.resume(returning: next) }
        // Only a different person signing in on top of the last one is news; the first session is just the start.
        if let previousUser, previousUser != userId { onUserChange?(userId) }
    }

    func clear() {
        let had = info != nil
        info = nil
        let pending = waiting
        waiting = []
        pending.forEach { $0.resume(throwing: Failure.notSignedIn) }
        if had { onUserChange?(nil) }
    }

    /// A session whose token is good for at least another minute, asking a page for one if it is not. `force` skips the check
    /// (the server said the token was no good).
    func validSession(force: Bool = false) async throws -> Info {
        if let info, !force, info.expiresAt.timeIntervalSinceNow > 60 { return info }
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.main.async { [self] in
                if let info, !force, info.expiresAt.timeIntervalSinceNow > 60 { continuation.resume(returning: info); return }
                waiting.append(continuation)
                // Several callers at once ask the page once.
                if refreshAsked == nil || Date().timeIntervalSince(refreshAsked!) > 5 {
                    refreshAsked = Date()
                    requestRefresh?(force)
                }
                // Nobody answered: give up rather than wait forever.
                DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.failWaiting() }
            }
        }
    }

    private func failWaiting() {
        guard !waiting.isEmpty else { return }
        let pending = waiting
        waiting = []
        pending.forEach { $0.resume(throwing: Failure.notSignedIn) }
    }
}

/// A web view nobody sees that keeps one page of the portal open (`/family-village/native-session`), so there is always a
/// page to sign in, refresh the session and hand it over, even when the person is only looking at native screens.
final class SessionBroker: NSObject, WKScriptMessageHandler {
    private var webView: WKWebView?

    func start(in host: UIView) {
        guard webView == nil else { return }
        let configuration = WKWebViewConfiguration()
        configuration.applicationNameForUserAgent = FrameConfig.userAgentName
        configuration.websiteDataStore = .default()
        configuration.userContentController.addUserScript(Bridge.userScript)
        configuration.userContentController.add(WeakScriptHandler(self), name: Bridge.handlerName)
        // On screen but invisible and one pixel big: iOS keeps timers running in a web view that is part of the window, and
        // supabase-js's refresh timer is the point of this one.
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: configuration)
        view.alpha = 0.01
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        view.accessibilityElementsHidden = true
        host.insertSubview(view, at: 0)
        webView = view
        NativeSession.shared.requestRefresh = { [weak self] force in
            guard let view = self?.webView else { return }
            Bridge.emit("session.refresh", payload: ["force": force], in: view)
        }
        view.load(URLRequest(url: FrameConfig.url(forPath: "/family-village/native-session")))
        FrameLog.event("session broker started")
    }

    func stop() {
        webView?.stopLoading()
        webView?.removeFromSuperview()
        webView = nil
        NativeSession.shared.requestRefresh = nil
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Bridge.handlerName, let request = BridgeMessage(message.body) else { return }
        switch request.type {
        case "session": NativeSession.shared.update(from: request.payload)
        case "log": FrameLog.event("broker: \(request.payload["text"] as? String ?? "")")
        default: break
        }
    }
}
