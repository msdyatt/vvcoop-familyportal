import SafariServices
import UIKit
import WebKit

/// One page of the portal, in its own web view.
///
/// Links and scripted navigations never load in place: they are cancelled here and handed to the
/// `Navigator`, which pushes a new page (see PathRules). Same-page changes, such as an anchor or
/// `history.pushState`, stay in the page. Those are how popups, reports, conversations and admin
/// tabs become history steps (lib/back-layers.ts), and the back button and back-swipe close them
/// first: `webView.canGoBack` is true exactly while the page has one open.
final class WebPageController: UIViewController {
    let url: URL
    private(set) var webView: WKWebView!
    weak var navigator: Navigator?

    /// True once the first load of this page has committed. Until then, redirects load in place.
    private var committed = false
    private var observers: [NSKeyValueObservation] = []
    private let progress = UIProgressView(progressViewStyle: .bar)
    private let failure = FailureView()
    private let refresh = UIRefreshControl()
    private var pageTitle: String?
    /// The last `state` this page sent (the person's bar, section, unread count). Applied again whenever
    /// the page comes back on top, so the bar always matches the page in view.
    private(set) var reportedState: FrameState?

    init(url: URL, navigator: Navigator?) {
        self.url = url
        self.navigator = navigator
        super.init(nibName: nil, bundle: nil)
        navigationItem.backButtonDisplayMode = .minimal
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// True while a popup, report, conversation or admin tab is open in this page.
    var hasInPageHistory: Bool { webView?.canGoBack ?? false }

    // MARK: Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Brand.cream
        buildWebView()
        buildProgress()
        buildFailureView()
        buildEdgeSwipe()
        load()
    }

    private func buildWebView() {
        let configuration = WKWebViewConfiguration()
        configuration.applicationNameForUserAgent = FrameConfig.userAgentName
        configuration.allowsInlineMediaPlayback = true
        configuration.websiteDataStore = .default()
        configuration.userContentController.addUserScript(Bridge.userScript)
        configuration.userContentController.add(WeakScriptHandler(self), name: Bridge.handlerName)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // Back is handled by the frame (see hasInPageHistory); the system's own web gesture stays off
        // so the two never both fire.
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = Brand.cream
        webView.scrollView.backgroundColor = Brand.cream
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        removeTopEdgeEffect(webView)

        refresh.tintColor = Brand.terracotta
        refresh.addTarget(self, action: #selector(pulledToRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        self.webView = webView

        observers = [
            webView.observe(\.canGoBack, options: [.initial, .new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.updateBackButton() }
            },
            webView.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
                DispatchQueue.main.async { self?.showProgress(view.estimatedProgress) }
            },
            webView.observe(\.title, options: [.new]) { [weak self] view, _ in
                DispatchQueue.main.async { self?.pageDidReportTitle(view.title) }
            },
        ]
    }

    /// iOS 26 blurs content that scrolls under a bar. The page is laid out below the navigation bar,
    /// so there is nothing to blur; this keeps the effect from drawing a haze at the top edge.
    private func removeTopEdgeEffect(_ webView: WKWebView) {
        if #available(iOS 26.0, *) { webView.scrollView.topEdgeEffect.isHidden = true }
    }

    private func buildProgress() {
        progress.progressTintColor = Brand.terracotta
        progress.trackTintColor = .clear
        progress.alpha = 0
        progress.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(progress)
        NSLayoutConstraint.activate([
            progress.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            progress.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    private func buildFailureView() {
        failure.isHidden = true
        failure.onRetry = { [weak self] in self?.load() }
        failure.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(failure)
        NSLayoutConstraint.activate([
            failure.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            failure.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            failure.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            failure.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    /// The back-swipe for pages with something open inside them. The system's pop gesture is refused
    /// while `hasInPageHistory` (see FrameNavigationController), so this takes the same left-edge
    /// swipe and closes the popup, report or tab instead of leaving the page.
    private func buildEdgeSwipe() {
        let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgeSwiped(_:)))
        edge.edges = .left
        edge.cancelsTouchesInView = false
        view.addGestureRecognizer(edge)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        refreshChrome()
    }

    /// The signed-in pages (the ones in a tab's stack) get the bell and the profile button; sheets and the
    /// sign-in page keep what they were given.
    func refreshChrome() {
        guard let frame = navigator?.chromeSource, (navigationController as? FrameNavigationController)?.tabKey != nil else { return }
        navigationItem.rightBarButtonItems = frame.chromeItems(for: self)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        navigator?.pageDidAppear(self)
    }

    func scrollToTop() {
        webView.scrollView.setContentOffset(CGPoint(x: 0, y: -webView.scrollView.adjustedContentInset.top), animated: true)
    }

    // MARK: Loading

    func load() {
        committed = false
        failure.isHidden = true
        webView.load(URLRequest(url: url))
    }

    @objc private func pulledToRefresh() {
        Haptics.play("selection")
        if failure.isHidden { committed = true; webView.reload() } else { load() }
    }

    // MARK: Back

    @objc private func goBackInPage() {
        guard webView.canGoBack else { return }
        FrameLog.event("back: closing something inside \(webView.url?.path ?? "?")")
        Haptics.play("selection")
        webView.goBack()
    }

    @objc private func edgeSwiped(_ gesture: UIScreenEdgePanGestureRecognizer) {
        FrameLog.event("edge swipe state=\(gesture.state.rawValue) inPageHistory=\(hasInPageHistory)")
        guard gesture.state == .ended, hasInPageHistory else { return }
        let travelled = gesture.translation(in: view).x
        let speed = gesture.velocity(in: view).x
        if travelled > 70 || speed > 500 { goBackInPage() }
    }

    /// With something open in the page, the back button closes it; with nothing open it is the
    /// navigation controller's own, which pops the page.
    private func updateBackButton() {
        FrameLog.event("canGoBack=\(hasInPageHistory) \(webView.url?.path ?? "?")")
        if hasInPageHistory {
            navigationItem.hidesBackButton = true
            navigationItem.leftBarButtonItem = UIBarButtonItem(
                image: UIImage(systemName: "chevron.backward"), style: .plain, target: self, action: #selector(goBackInPage))
            navigationItem.leftBarButtonItem?.accessibilityLabel = "Back"
        } else {
            navigationItem.hidesBackButton = false
            navigationItem.leftBarButtonItem = nil
        }
        navigationController?.interactivePopGestureRecognizer?.isEnabled = true
    }

    // MARK: Title and progress

    private func pageDidReportTitle(_ raw: String?) {
        guard pageTitle == nil else { return } // the page set one itself over the bridge
        navigationItem.title = Self.cleanTitle(raw)
    }

    /// Page titles read "Family | Veritas Village"; the app already says whose it is.
    static func cleanTitle(_ raw: String?) -> String? {
        guard var title = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { return nil }
        for separator in [" | Veritas Village", " – Veritas Village", " - Veritas Village", "Veritas Village | "] {
            title = title.replacingOccurrences(of: separator, with: "")
        }
        return title == "Veritas Village" ? nil : title
    }

    private func showProgress(_ value: Double) {
        if value >= 1 {
            UIView.animate(withDuration: 0.25, delay: 0.1) { self.progress.alpha = 0 } completion: { _ in self.progress.setProgress(0, animated: false) }
        } else {
            progress.alpha = 1
            progress.setProgress(Float(value), animated: true)
        }
    }
}

// MARK: - Navigation policy

extension WebPageController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = action.request.url else { return decisionHandler(.cancel) }

        // Frames inside the page (an embedded payment form, a PDF viewer) are the page's business.
        if let frame = action.targetFrame, !frame.isMainFrame { return decisionHandler(.allow) }

        switch target.scheme {
        case "http", "https": break
        case "about", "blob", "data": return decisionHandler(.allow)
        default: // mailto:, tel:, sms:, maps: ...
            decisionHandler(.cancel)
            UIApplication.shared.open(target)
            return
        }

        // A link with a target of its own (target="_blank", window.open): same rules as any link.
        if action.targetFrame == nil {
            decisionHandler(.cancel)
            navigator?.open(target, from: self)
            return
        }

        switch action.navigationType {
        case .backForward, .reload, .formSubmitted, .formResubmitted:
            return decisionHandler(.allow)
        default:
            break
        }

        // The first load of this page, and any redirects it makes, happen in place.
        if !committed { return decisionHandler(.allow) }

        // An anchor within this page, or a tap on a link to the page already showing.
        if Self.sameDocument(target, webView.url) {
            if target.fragment != nil { return decisionHandler(.allow) }
            decisionHandler(.cancel)
            scrollToTop()
            return
        }

        decisionHandler(.cancel)
        navigator?.open(target, from: self)
    }

    private static func sameDocument(_ a: URL, _ b: URL?) -> Bool {
        guard let b else { return false }
        func bare(_ url: URL) -> String? {
            guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
            parts.fragment = nil
            return parts.string
        }
        return bare(a) == bare(b)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        committed = true
        failure.isHidden = true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        refresh.endRefreshing()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        refresh.endRefreshing()
        if (error as NSError).code == NSURLErrorCancelled { return }
        failure.isHidden = false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        refresh.endRefreshing()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        load()
    }
}

// MARK: - JavaScript dialogs and new windows

extension WebPageController: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let target = action.request.url { navigator?.open(target, from: self) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }
}

// MARK: - Messages from the page

extension WebPageController: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Bridge.handlerName, let request = BridgeMessage(message.body) else { return }
        FrameLog.event("bridge: \(request.type)")
        switch request.type {
        case "ping":
            Bridge.reply(to: request, value: ["pong": true, "platform": "ios", "version": FrameConfig.bridgeVersion], in: webView)

        case "haptic":
            Haptics.play(request.payload["style"] as? String ?? "selection")

        case "title":
            pageTitle = request.payload["title"] as? String
            navigationItem.title = pageTitle

        case "navigate":
            if let text = request.payload["url"] as? String, let target = URL(string: text, relativeTo: webView.url)?.absoluteURL {
                navigator?.open(target, from: self)
            }

        case "close":
            navigator?.close(self)

        case "state":
            if let state = FrameState.decode(request.payload) {
                reportedState = state
                navigator?.pageReportedState(self, state)
            }

        case "notifications":
            navigator?.chromeSource?.setNotificationUnread(request.payload["unread"] as? Int ?? 0)

        case "log":
            FrameLog.event("page: \(request.payload["text"] as? String ?? "")")

        default:
            Bridge.reply(to: request, error: "Unknown message type \(request.type)", in: webView)
        }
    }
}

// MARK: - Can't reach the site

/// Shown when a page cannot be loaded (no connection, site down). Replaces the old launch page that
/// checked the connection.
final class FailureView: UIView {
    var onRetry: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = Brand.cream

        let title = UILabel()
        title.text = "Can't reach Veritas Village"
        title.font = UIFont.systemFont(ofSize: 20, weight: .semibold)
        title.textColor = Brand.navy
        title.textAlignment = .center
        title.numberOfLines = 0

        let detail = UILabel()
        detail.text = "Check your connection and try again."
        detail.font = UIFont.preferredFont(forTextStyle: .body)
        detail.textColor = Brand.navy.withAlphaComponent(0.7)
        detail.textAlignment = .center
        detail.numberOfLines = 0

        var configuration = UIButton.Configuration.filled()
        configuration.title = "Try again"
        configuration.baseBackgroundColor = Brand.navy
        configuration.baseForegroundColor = Brand.cream
        configuration.cornerStyle = .capsule
        let retry = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in self?.onRetry?() })

        let stack = UIStackView(arrangedSubviews: [title, detail, retry])
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -30),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -32),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
