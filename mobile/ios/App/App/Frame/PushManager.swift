import FirebaseCore
import FirebaseMessaging
import UIKit
import UserNotifications

/// Push notifications for the iPhone frame.
///
/// The server half is PR #16's: the page registers a Firebase (FCM) token with `register_device_token`,
/// and `deliver-push` sends through FCM with the notification's `link_path` as `data.url`. This is the
/// phone half, called from the page through the bridge (`push.status`, `push.enable`, `push.token`,
/// `push.disable`) so `lib/push.ts` has one code path with Android. Taps never go through the page:
/// they are read here and opened by the frame, so they also work before any page has loaded.
final class PushManager: NSObject {
    static let shared = PushManager()

    /// Set by the scene: opens a path from the site (the frame decides which tab and whether to wait for sign-in).
    var openPath: ((String) -> Void)?
    /// Set by the scene: tells the page on screen that Firebase rotated the token.
    var tokenChanged: ((String) -> Void)?

    private var token: String?
    private var waiting: [(String?) -> Void] = []

    func configure() {
        FirebaseApp.configure()
        Messaging.messaging().delegate = self
        UNUserNotificationCenter.current().delegate = self
        // A person who already allowed notifications gets a token without being asked again.
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            if settings.authorizationStatus == .authorized {
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            }
        }
    }

    // MARK: Bridge calls

    func status(_ done: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let value: String
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: value = "granted"
            case .denied: value = "denied"
            default: value = "prompt"
            }
            DispatchQueue.main.async { done(value) }
        }
    }

    func enable(_ done: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            DispatchQueue.main.async {
                if granted { UIApplication.shared.registerForRemoteNotifications() }
                done(granted ? "granted" : "denied")
            }
        }
    }

    /// The Firebase token, waiting up to ten seconds for Apple to hand over the device token first.
    func fetchToken(_ done: @escaping (String?) -> Void) {
        if let token { done(token); return }
        waiting.append(done)
        Messaging.messaging().token { [weak self] token, _ in
            DispatchQueue.main.async { if let token { self?.deliver(token) } }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, !self.waiting.isEmpty else { return }
            let pending = self.waiting
            self.waiting = []
            pending.forEach { $0(nil) }
        }
    }

    func disable(_ done: @escaping () -> Void) {
        token = nil
        Messaging.messaging().deleteToken { _ in
            DispatchQueue.main.async {
                UIApplication.shared.unregisterForRemoteNotifications()
                done()
            }
        }
    }

    private func deliver(_ value: String) {
        token = value
        let pending = waiting
        waiting = []
        pending.forEach { $0(value) }
    }
}

extension PushManager: MessagingDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken else { return }
        DispatchQueue.main.async {
            let changed = self.token != nil && self.token != fcmToken
            self.deliver(fcmToken)
            if changed { self.tokenChanged?(fcmToken) }
        }
    }
}

extension PushManager: UNUserNotificationCenterDelegate {
    /// A notification arriving while the app is open still shows as a banner, like the web push does.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound, .badge])
    }

    /// A tap on a notification: open the page its `url` names (the server only ever sends paths on this site).
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let path = Self.safePath(info["url"])
        DispatchQueue.main.async { self.openPath?(path) }
        completionHandler()
    }

    /// The same rule as `safeAppPath` in lib/native.ts and the server: only a path on this site.
    static func safePath(_ value: Any?) -> String {
        guard let path = value as? String, path.hasPrefix("/"), !path.hasPrefix("//"), !path.hasPrefix("/\\") else {
            return "/family-village/home"
        }
        return path
    }
}
