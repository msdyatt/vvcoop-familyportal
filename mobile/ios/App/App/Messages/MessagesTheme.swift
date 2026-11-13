import SwiftUI
import UIKit

/// Messages colours and type, in the app's palette. The roles match the web's tokens (app/globals.css, app/theme.css) in Light
/// and Dark, so the screens are the same family as the website: navy `#0b2a3d`, cream `#faf7f1`, terracotta `#bb6141` as an
/// accent only, sage `#6f7d72`, antique gold `#aa7d38`. Dynamic colours: UIKit picks the light or dark value from the window,
/// which the frame sets from the person's choice (Brand.setTheme).
enum MT {
    private static func hex(_ rgb: UInt32) -> UIColor {
        UIColor(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> UIColor {
        UIColor { $0.userInterfaceStyle == .dark ? hex(dark) : hex(light) }
    }

    // Roles (web: --surface, --surface-sunken, --text, --text-muted, --text-accent, --warm-tint, --danger-text, --action ...)
    static let surfaceUI = dynamic(0xFFFDF9, 0x0E3045)
    static let sunkenUI = dynamic(0xF2EEE5, 0x061A27)
    static let canvasUI = dynamic(0xFAF7F1, 0x08202F)
    static let textUI = dynamic(0x0B2A3D, 0xFAF7F1)
    static let mutedUI = dynamic(0x5F6B61, 0xBBC0B8)
    static let accentTextUI = dynamic(0xA85539, 0xD7A590)
    static let warmTintUI = dynamic(0xF4E4DC, 0x3A2730)
    static let dangerTextUI = dynamic(0x6B3826, 0xF3C6B3)
    /// Fill of your own bubbles and primary buttons: navy, and the deeper terracotta in Dark.
    static let actionUI = dynamic(0x0B2A3D, 0xA85539)
    static let accentOnActionUI = dynamic(0xD7A590, 0xFAF7F1)
    static let goldUI = dynamic(0xAA7D38, 0xE0B56A)
    static let terracottaUI = hex(0xBB6141)
    static let cream = hex(0xFAF7F1)
    /// A hairline: the text colour at about 12% (web: rgba(var(--fg-rgb), .12)).
    static let lineUI = UIColor { $0.userInterfaceStyle == .dark ? hex(0xFAF7F1).withAlphaComponent(0.14) : hex(0x0B2A3D).withAlphaComponent(0.12) }

    static let surface = Color(surfaceUI)
    static let sunken = Color(sunkenUI)
    static let canvas = Color(canvasUI)
    static let text = Color(textUI)
    static let muted = Color(mutedUI)
    static let accentText = Color(accentTextUI)
    static let warmTint = Color(warmTintUI)
    static let dangerText = Color(dangerTextUI)
    static let action = Color(actionUI)
    static let accentOnAction = Color(accentOnActionUI)
    static let gold = Color(goldUI)
    static let terracotta = Color(terracottaUI)
    static let line = Color(lineUI)

    // MARK: Person colours

    /// The six tints (web: .pc-0 .. .pc-5), chosen from an id by `MessageTone.toneFor`.
    static let fills: [UInt32] = [0xA95C41, 0x8C6A2A, 0x637469, 0x4A6A86, 0xA15A64, 0x3D7479]

    static func mix(_ a: UIColor, _ b: UIColor, share: CGFloat, traits: UITraitCollection) -> UIColor {
        var (ar, ag, ab, aa): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (br, bg, bb, ba): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        a.resolvedColor(with: traits).getRed(&ar, green: &ag, blue: &ab, alpha: &aa)
        b.resolvedColor(with: traits).getRed(&br, green: &bg, blue: &bb, alpha: &ba)
        return UIColor(red: ar * share + br * (1 - share), green: ag * share + bg * (1 - share), blue: ab * share + bb * (1 - share), alpha: 1)
    }

    /// Avatar and accent fill: cream text on it clears 4.5:1 in both themes.
    static func fill(_ tone: Int) -> Color { Color(hex(fills[tone % fills.count])) }

    /// The bubble and header tint: 26% of the fill over the surface, so it follows the theme.
    static func wash(_ tone: Int) -> Color {
        let fill = hex(fills[tone % fills.count])
        return Color(UIColor { mix(fill, surfaceUI, share: 0.26, traits: $0) })
    }

    /// Name colour: the fill mixed toward the text colour (68% fill in Light, 50% in Dark), readable on the wash.
    static func name(_ tone: Int) -> Color {
        let fill = hex(fills[tone % fills.count])
        return Color(UIColor { mix(fill, textUI, share: $0.userInterfaceStyle == .dark ? 0.5 : 0.68, traits: $0) })
    }

    // MARK: Type

    /// Playfair Display is a web font the app does not carry; the system serif (New York) is the closest native match, as in the header.
    /// Text styles, so it follows Dynamic Type.
    static func serif(_ style: Font.TextStyle, weight: Font.Weight = .bold) -> Font {
        .system(style, design: .serif).weight(weight)
    }
}

extension View {
    /// Plain list rows that draw their own background.
    func plainRow(_ background: Color = MT.surface) -> some View {
        self.listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(background)
    }
}

/// Reduce Motion: true when the person has asked for less animation.
var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }
