import UIKit

/// A navigation controller in the app's look (navy bar, light text) whose edge-swipe gives way to
/// the page when the page has something open inside it.
final class FrameNavigationController: UINavigationController, UIGestureRecognizerDelegate {
    enum Style {
        /// The pages of the app: navy bar, light text, to match the navy status strip.
        case navy
        /// Sheets: a light bar, so the sheet's grabber and Done button read.
        case cream
    }

    private let style: Style
    /// For a tab's stack: which tab it belongs to ("section/destination id").
    let tabKey: String?

    init(rootViewController: UIViewController, style: Style = .navy, tabKey: String? = nil) {
        self.style = style
        self.tabKey = tabKey
        super.init(rootViewController: rootViewController)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Sheets keep the system navigation bar. Everything else (the sign-in page and the signed-in pages) draws its
    /// own top: a navy status strip, and on signed-in pages the section header (HeaderBand.swift).
    var isSheet: Bool { style == .cream }

    override func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
        isNavigationBarHidden = !isSheet

        let foreground = style == .navy ? Brand.cream : Brand.navy
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = style == .navy ? Brand.navy : Brand.cream
        appearance.shadowColor = .clear
        appearance.titleTextAttributes = [.foregroundColor: foreground, .font: UIFont.systemFont(ofSize: 17, weight: .semibold)]
        navigationBar.standardAppearance = appearance
        navigationBar.scrollEdgeAppearance = appearance
        navigationBar.compactAppearance = appearance
        navigationBar.tintColor = foreground
        navigationBar.barStyle = style == .navy ? .black : .default
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { style == .navy ? .lightContent : .darkContent }

    /// The system's back-swipe pops a page. While the page has a popup, report, conversation or tab
    /// open, that swipe is the page's to handle (it closes the layer), so it is refused here.
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === interactivePopGestureRecognizer else { return true }
        guard viewControllers.count > 1 else { return false }
        let allowed = !((topViewController as? WebPageController)?.hasInPageHistory ?? false)
        FrameLog.event("system back-swipe \(allowed ? "allowed" : "refused: page has something open")")
        return allowed
    }
}
