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
    /// The first page of the portal, for the Menu's "Family home" row.
    let home: String
    let bar: [FrameDestination]
    let menu: [FrameMenuGroup]

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
