import SafariServices
import UIKit

/// Decides what a request to open a URL turns into, using the path rules, and does it.
final class Navigator {
    private unowned let frame: FrameController
    private var lastOpened: (url: URL, at: Date)?

    init(frame: FrameController) { self.frame = frame }

    /// `page` is the page the request came from (nil for the native side, such as a notification tap).
    func open(_ url: URL, from page: WebPageController?) {
        guard FrameConfig.isPortal(url) else { openExternally(url); return }

        // A double tap should not stack the same page twice.
        if let last = lastOpened, last.url == url, Date().timeIntervalSince(last.at) < 0.6 { return }
        lastOpened = (url, Date())

        let rules = PathRules.shared
        let properties = rules.properties(for: url)
        let leavingSignIn = page.map { rules.properties(for: $0.webView.url ?? $0.url).role == "signin" } ?? false

        FrameLog.event("open \(url.path) as \(properties.presentation.rawValue)")
        switch properties.presentation {
        case .push:
            if leavingSignIn { replace(page, with: url) } else { push(url, from: page) }
        case .replace:
            replace(page, with: url)
        case .sheet:
            presentSheet(url, detent: properties.detent)
        case .root:
            frame.showRoot(url)
        case .external:
            openExternally(url)
        case .none:
            break
        }
    }

    /// Closes the page: dismisses it if it is a sheet's first page, otherwise pops it.
    func close(_ page: WebPageController) {
        if let navigation = page.navigationController {
            if navigation.viewControllers.first === page, navigation.presentingViewController != nil {
                navigation.dismiss(animated: true)
            } else if navigation.viewControllers.count > 1 {
                navigation.popViewController(animated: true)
            }
        }
    }

    // MARK: Presentations

    private func push(_ url: URL, from page: WebPageController?) {
        let next = WebPageController(url: url, navigator: self)
        navigation(for: page).pushViewController(next, animated: true)
    }

    private func replace(_ page: WebPageController?, with url: URL) {
        let next = WebPageController(url: url, navigator: self)
        let navigation = navigation(for: page)
        var stack = navigation.viewControllers
        if !stack.isEmpty { stack.removeLast() }
        navigation.setViewControllers(stack + [next], animated: true)
    }

    private func presentSheet(_ url: URL, detent: String?) {
        let page = WebPageController(url: url, navigator: self)
        let navigation = FrameNavigationController(rootViewController: page, style: .cream)
        page.navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak navigation] _ in
            navigation?.dismiss(animated: true)
        })
        navigation.modalPresentationStyle = .pageSheet
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = detent == "large" ? [.large()] : [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        frame.topPresenter.present(navigation, animated: true)
    }

    private func navigation(for page: WebPageController?) -> UINavigationController {
        page?.navigationController ?? frame.content
    }

    func openExternally(_ url: URL) {
        guard ["http", "https"].contains(url.scheme ?? "") else { UIApplication.shared.open(url); return }
        let controller = SFSafariViewController(url: url)
        controller.preferredBarTintColor = Brand.navy
        controller.preferredControlTintColor = Brand.cream
        frame.topPresenter.present(controller, animated: true)
    }
}
