import os
import UIKit

/// Where the website lives and how the frame identifies itself to it.
enum FrameConfig {
    /// Bumped when the page-facing bridge changes in a way the website has to know about.
    static let bridgeVersion = 1

    /// Appended to the web view's user agent, so the site and its logs can tell the app from Safari.
    static let userAgentName = "VeritasVillageApp/1"

    static let supabaseHost = "jtwemgyhxylbhjzxgyvh.supabase.co"

    /// The portal. Debug builds can point somewhere else with `-VVBaseURL http://localhost:8765`
    /// (used with the test pages); a release build always uses the real site.
    static var baseURL: URL {
        #if DEBUG
        if let override = UserDefaults.standard.string(forKey: "VVBaseURL"), let url = URL(string: override) { return url }
        #endif
        return URL(string: "https://family.veritasvillage.org")!
    }

    /// The first page. The sign-in screen: it sends people who already have a session on to their home.
    static var startPath: String {
        #if DEBUG
        if let path = UserDefaults.standard.string(forKey: "VVStartPath") { return path }
        #endif
        return "/family-village"
    }

    static var startURL: URL { url(forPath: startPath) }

    static func url(forPath path: String) -> URL {
        URL(string: path, relativeTo: baseURL)?.absoluteURL ?? baseURL
    }

    /// Pages on the portal's own host open inside the frame; everything else opens in the system browser.
    static func isPortal(_ url: URL) -> Bool {
        guard let host = url.host, let base = baseURL.host else { return false }
        return host == base && (url.port ?? defaultPort(url)) == (baseURL.port ?? defaultPort(baseURL))
    }

    static func isSupabase(_ url: URL) -> Bool { url.host == supabaseHost }

    private static func defaultPort(_ url: URL) -> Int { url.scheme == "https" ? 443 : 80 }
}

/// The brand colours the frame needs. The web keeps its own tokens in globals.css; these match them.
enum Brand {
    static let navy = UIColor(red: 0x0B / 255, green: 0x2A / 255, blue: 0x3D / 255, alpha: 1)
    static let cream = UIColor(red: 0xFA / 255, green: 0xF7 / 255, blue: 0xF1 / 255, alpha: 1)
    static let terracotta = UIColor(red: 0xBB / 255, green: 0x61 / 255, blue: 0x41 / 255, alpha: 1)
}

/// Frame events in the unified log (subsystem org.veritasvillage.family, category "frame"), so
/// navigation can be followed without a debugger: `log stream --predicate 'subsystem == "org.veritasvillage.family"'`.
enum FrameLog {
    private static let logger = Logger(subsystem: "org.veritasvillage.family", category: "frame")
    static func event(_ message: String) { logger.notice("\(message, privacy: .public)") }
}
