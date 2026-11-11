import UIKit

/// What the signed-in pages tell the frame (`VVNative.post("state", ...)`, built by
/// `buildFrameState` in lib/native-frame.ts). The web works out the person's own bar choices;
/// the frame only draws them. There is one bar for the whole app.
struct FrameDestination: Codable, Equatable {
    let id: String
    let label: String
    let href: String
    let icon: String
}

struct FrameMenuGroup: Codable, Equatable {
    let title: String
    let items: [FrameDestination]
}

struct FrameState: Codable, Equatable {
    let signedIn: Bool
    let unread: Int
    /// The first page of the portal, for the Menu's "Home" row.
    let home: String
    let bar: [FrameDestination]
    let menu: [FrameMenuGroup]

    private enum Keys: String, CodingKey { case signedIn, unread, home, bar, menu, sections }
    private struct LegacySection: Decodable { let id: String; let bar: [FrameDestination] }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        signedIn = try c.decode(Bool.self, forKey: .signedIn)
        unread = try c.decodeIfPresent(Int.self, forKey: .unread) ?? 0
        home = try c.decodeIfPresent(String.self, forKey: .home) ?? "/family-village/home"
        menu = (try? c.decode([FrameMenuGroup].self, forKey: .menu)) ?? []
        if let bar = try c.decodeIfPresent([FrameDestination].self, forKey: .bar) {
            self.bar = bar
        } else {
            // A page from before the app had one bar for everything sends one bar per section. Use the main
            // (Family) one, so the bar never changes with the page and an older site still works.
            let sections = (try? c.decode([LegacySection].self, forKey: .sections)) ?? []
            bar = (sections.first { $0.id == "home" } ?? sections.first)?.bar ?? []
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(signedIn, forKey: .signedIn)
        try c.encode(unread, forKey: .unread)
        try c.encode(home, forKey: .home)
        try c.encode(bar, forKey: .bar)
        try c.encode(menu, forKey: .menu)
    }

    static func decode(_ payload: [String: Any]) -> FrameState? {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        return try? JSONDecoder().decode(FrameState.self, from: data)
    }
}

enum Symbols {
    /// The web's icon names (lib/nav-prefs.ts IconName) as SF Symbols.
    static func image(for name: String) -> UIImage? {
        let symbol: String
        switch name {
        case "home": symbol = "house"
        case "photos": symbol = "photo.on.rectangle"
        case "messages": symbol = "bubble.left"
        case "menu": symbol = "line.3.horizontal"
        case "news": symbol = "newspaper"
        case "calendar": symbol = "calendar"
        case "children": symbol = "figure.2.and.child.holdinghands"
        case "paperwork": symbol = "doc.text"
        case "teach": symbol = "graduationcap"
        case "classes": symbol = "book"
        case "dashboard": symbol = "square.grid.2x2"
        case "families": symbol = "person.3"
        case "invitations": symbol = "envelope"
        case "compliance": symbol = "checkmark.shield"
        case "reports": symbol = "chart.bar"
        case "activity": symbol = "waveform.path.ecg"
        case "integrations": symbol = "powerplug"
        case "flag": symbol = "flag"
        default: symbol = "circle"
        }
        return UIImage(systemName: symbol) ?? UIImage(systemName: "circle")
    }
}
