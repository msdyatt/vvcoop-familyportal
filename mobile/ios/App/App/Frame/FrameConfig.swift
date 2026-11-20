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
    /// Alerts and destructive actions. Terracotta like the Veritas accent, but fixed: a co-op's palette never changes it.
    static let danger = UIColor(red: 0xBB / 255, green: 0x61 / 255, blue: 0x41 / 255, alpha: 1)

    // MARK: The co-op's accent
    // The co-op's palette (Admin, Appearance; lib/coop-theme.ts). The page reports it with the `coopTheme` message on every
    // load (lib/coop-settings.ts); the frame keeps it so the next launch starts in the right colours. Only the accent family
    // follows it: navy, cream, the surfaces and the alert colour stay as they are.
    struct Accent: Equatable {
        var accent: UInt32       // web --terracotta: rules, the unread badge, progress
        var accentText: UInt32   // web --terracotta-text: small accent text on light grounds
        var accentOnInk: UInt32  // web --terracotta-on-navy: accent on navy, and small accent text in Dark
        var nightFill: UInt32    // web --accent-night-fill: buttons and selections in Dark
    }
    static let veritasAccent = Accent(accent: 0xBB6141, accentText: 0xA85539, accentOnInk: 0xD7A590, nightFill: 0xA85539)
    private static let accentKey = "vv.coop.accent"
    private static let nameKey = "vv.coop.name"
    private(set) static var coopAccent: Accent = storedAccent()
    /// The co-op's name, for the logo's spoken label.
    private(set) static var coopName: String = UserDefaults.standard.string(forKey: nameKey) ?? "Veritas Village"

    private static func storedAccent() -> Accent {
        guard let saved = UserDefaults.standard.dictionary(forKey: accentKey) as? [String: Int],
              let a = saved["accent"], let t = saved["accentText"], let o = saved["accentOnInk"], let f = saved["nightFill"]
        else { return veritasAccent }
        return Accent(accent: UInt32(a), accentText: UInt32(t), accentOnInk: UInt32(o), nightFill: UInt32(f))
    }
    /// "#rrggbb" as a number, or nil.
    static func parseHex(_ value: Any?) -> UInt32? {
        guard let text = value as? String, text.count == 7, text.hasPrefix("#"), let n = UInt32(text.dropFirst(), radix: 16) else { return nil }
        return n
    }
    /// Takes the page's `coopTheme` message. Returns true when something changed. A malformed palette is ignored whole.
    @discardableResult
    static func setCoopTheme(_ payload: [String: Any]) -> Bool {
        var changed = false
        if let a = parseHex(payload["accent"]), let t = parseHex(payload["accentText"]), let o = parseHex(payload["accentOnInk"]), let f = parseHex(payload["nightFill"]) {
            let next = Accent(accent: a, accentText: t, accentOnInk: o, nightFill: f)
            if next != coopAccent {
                coopAccent = next
                UserDefaults.standard.set(["accent": Int(a), "accentText": Int(t), "accentOnInk": Int(o), "nightFill": Int(f)], forKey: accentKey)
                changed = true
            }
        }
        if let name = payload["name"] as? String, !name.isEmpty, name.count <= 80, name != coopName {
            coopName = name
            UserDefaults.standard.set(name, forKey: nameKey)
            changed = true
        }
        return changed
    }
    static func color(_ rgb: UInt32) -> UIColor { hex(rgb) }

    /// The co-op's accent (web `--terracotta`). Dynamic, so it is read when drawn and follows a change of palette.
    static let terracotta = UIColor { _ in hex(coopAccent.accent) }
    /// Accent on a navy band (web `--terracotta-on-navy`), the same in both themes.
    static let accentOnInk = UIColor { _ in hex(coopAccent.accentOnInk) }

    // MARK: Roles that follow Light / Dark
    // The web's role tokens (app/globals.css, app/theme.css) as dynamic colours: UIKit picks the light or the dark value from
    // the window's interface style, so every view that uses a role re-colours by itself when the theme changes.

    private static func hex(_ rgb: UInt32) -> UIColor {
        UIColor(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
    private static func dynamic(light: UIColor, dark: UIColor) -> UIColor {
        UIColor { $0.userInterfaceStyle == .dark ? dark : light }
    }
    /// The page itself (web `--canvas`).
    static let canvas = dynamic(light: cream, dark: hex(0x08202F))
    /// Text and icons on the canvas (web `--text`).
    static let ink = dynamic(light: navy, dark: cream)
    /// A solid dark band: the strip behind the clock, the Admin header (web `--ink-surface`).
    static let band = dynamic(light: navy, dark: hex(0x0D3A57))
    /// A raised row or card (web `--surface`).
    static let surface = dynamic(light: .white, dark: hex(0x0E3045))
    /// The selected tab, switches and primary buttons (web `--action`, with terracotta-on-navy for a selection on the dark canvas).
    static let action = UIColor { $0.userInterfaceStyle == .dark ? hex(coopAccent.nightFill) : navy }
    static let selection = UIColor { $0.userInterfaceStyle == .dark ? hex(coopAccent.accentOnInk) : navy }

    // MARK: The person's choice (Light / Dark / System)
    // The page tells the frame which one is in force (`theme` message, lib/theme.ts). The frame keeps it so the next launch
    // is dressed correctly from the first frame, and applies it to the windows: System leaves them to follow the phone.
    private static let themeKey = "vv.theme"
    static func setTheme(_ choice: String) {
        guard ["system", "light", "dark"].contains(choice) else { return }
        UserDefaults.standard.set(choice, forKey: themeKey)
        applyStoredTheme()
    }
    static func applyStoredTheme() {
        let style: UIUserInterfaceStyle
        switch UserDefaults.standard.string(forKey: themeKey) {
        case "dark": style = .dark
        case "light": style = .light
        default: style = .unspecified
        }
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows { window.overrideUserInterfaceStyle = style }
        }
    }
}

/// Frame events in the unified log (subsystem org.veritasvillage.family, category "frame"), so
/// navigation can be followed without a debugger: `log stream --predicate 'subsystem == "org.veritasvillage.family"'`.
enum FrameLog {
    private static let logger = Logger(subsystem: "org.veritasvillage.family", category: "frame")
    static func event(_ message: String) { logger.notice("\(message, privacy: .public)") }
}
