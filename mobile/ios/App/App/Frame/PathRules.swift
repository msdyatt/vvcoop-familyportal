import Foundation

/// What to do when a page asks to go to another URL on the portal.
///
/// The rules live in `path-configuration.json` (bundled with the app). The first rule whose
/// pattern matches the path and query wins, so the catch-all comes last. The same file format
/// can be fetched from the site later so a rule can change without a store build.
enum Presentation: String, Decodable {
    /// A new page on top of the current one, with the native push animation. The default.
    case push
    /// The current page is swapped for the new one.
    case replace
    /// A sheet that rises from the bottom, with its own navigation inside.
    case sheet
    /// Start over from this page (the sign-in screen): drops every stack and tab.
    case root
    /// Open in the system browser.
    case external
    /// Ignore the request.
    case none
}

struct PathProperties: Decodable {
    var presentation: Presentation
    /// For sheets: "medium" or "large".
    var detent: String?
    /// "signin" marks the sign-in page: leaving it replaces it instead of stacking on top.
    var role: String?
    /// For sheets: "frame" means a link tapped inside the sheet closes the sheet and opens in the page
    /// stack underneath (the notification list); otherwise links open inside the sheet.
    var links: String?
}

struct PathRule: Decodable {
    let patterns: [String]
    let properties: PathProperties
}

final class PathRules {
    static let shared = PathRules.loadBundled()

    private struct Compiled { let expressions: [NSRegularExpression]; let properties: PathProperties }
    private let rules: [Compiled]

    init(rules: [PathRule]) {
        self.rules = rules.map { rule in
            Compiled(expressions: rule.patterns.compactMap { try? NSRegularExpression(pattern: $0) }, properties: rule.properties)
        }
    }

    private struct File: Decodable { let rules: [PathRule] }

    static func loadBundled() -> PathRules {
        guard let url = Bundle.main.url(forResource: "path-configuration", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(File.self, from: data) else {
            return PathRules(rules: [])
        }
        return PathRules(rules: file.rules)
    }

    func properties(for url: URL) -> PathProperties {
        var target = url.path
        if let query = url.query { target += "?" + query }
        let range = NSRange(target.startIndex..., in: target)
        for rule in rules where rule.expressions.contains(where: { $0.firstMatch(in: target, range: range) != nil }) {
            return rule.properties
        }
        return PathProperties(presentation: .push, detent: nil, role: nil, links: nil)
    }
}
