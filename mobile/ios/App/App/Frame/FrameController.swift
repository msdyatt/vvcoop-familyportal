import UIKit

/// The app's root screen.
///
/// Signed out: one navigation stack holding the sign-in page, no tab bar.
/// Signed in: a native tab bar under a navigation stack per tab. Which tabs there are is whatever the
/// page last told us (`FrameState`, from the person's own choices); the last item is always Menu.
///
/// The bar always follows the page on top: when a page appears, the state it reported is applied. So a
/// page that belongs to another section (a Teacher page opened from Family home) shows the same bar. There is
/// one bar for the whole app (the person's main one), so it never changes as they move around.
final class FrameController: UIViewController, UITabBarDelegate {
    private(set) lazy var navigator = Navigator(frame: self)
    private let container = UIView()
    private let tabBar = UITabBar()
    private var containerBottomToTabBar: NSLayoutConstraint!
    private var containerBottomToView: NSLayoutConstraint!

    /// The stack on screen. Signed out, the sign-in stack; signed in, the selected tab's.
    private(set) var content: FrameNavigationController!
    private var signedOut: FrameNavigationController?

    private var state: FrameState?
    private var stacks: [String: FrameNavigationController] = [:]
    private var barKeys: [String] = []
    private static let menuTag = -1
    private(set) var notificationUnread = 0
    /// Unread messages as the native Messages screens count them. Once known, it wins over the number the pages report
    /// (both come from the same `unread_message_count`), so the badge stays right when no web page is loaded.
    private var nativeMessagesUnread: Int?

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var childForStatusBarStyle: UIViewController? { content }

    // MARK: Setup

    override func viewDidLoad() {
        super.viewDidLoad()
        Brand.applyStoredTheme()
        view.backgroundColor = Brand.canvas

        container.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(container)

        tabBar.translatesAutoresizingMaskIntoConstraints = false
        tabBar.delegate = self
        tabBar.tintColor = Brand.selection
        tabBar.isHidden = true
        view.addSubview(tabBar)

        containerBottomToTabBar = container.bottomAnchor.constraint(equalTo: tabBar.topAnchor)
        containerBottomToView = container.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        NSLayoutConstraint.activate([
            container.topAnchor.constraint(equalTo: view.topAnchor),
            container.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            containerBottomToView,
            tabBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tabBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tabBar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        showSplash()
        if let cached = FrameStore.loadState(), cached.signedIn, !cached.bar.isEmpty {
            // Open straight into the bar they had last time. If the session is gone, the page redirects to
            // sign-in and the frame goes back to signed-out.
            state = cached
            NativeMessages.shared.signedIn(frame: self)
            rebuildBar()
            select(key: FrameStore.lastKey().flatMap { barKeys.contains($0) ? $0 : nil } ?? barKeys[0])
            // A tap that launched the app is waiting; the cached bar is enough to open it.
            DispatchQueue.main.async { self.openPendingPath() }
        } else {
            showSignedOut(FrameConfig.startURL)
        }
    }

    // MARK: Loading screen

    private var splash: SplashView?

    /// Covers everything from launch until the first page has loaded (see SplashView). A page that never finishes does
    /// not hold it for more than a few seconds.
    private func showSplash() {
        let splash = SplashView()
        splash.frame = view.bounds
        splash.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(splash)
        self.splash = splash
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in self?.hideSplash() }
    }

    func hideSplash() {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "VVHoldSplash") { return } // lets the screen be looked at
        #endif
        guard let splash else { return }
        self.splash = nil
        UIView.animate(withDuration: 0.25, animations: { splash.alpha = 0 }, completion: { _ in splash.removeFromSuperview() })
    }

    // MARK: Signed out

    /// Starts over from one page (the sign-in screen): drops every stack, the tab bar and what was remembered.
    func showRoot(_ url: URL) {
        if presentedViewController != nil { dismiss(animated: false) }
        showSignedOut(url)
    }

    private func showSignedOut(_ url: URL) {
        notificationUnread = 0
        FrameLog.event("signed out: sign-in page \(url.path)")
        NativeMessages.shared.signedOut()
        nativeMessagesUnread = nil
        stacks.removeAll()
        barKeys.removeAll()
        tabBar.setItems(nil, animated: false)
        state = nil
        FrameStore.clear()
        let stack = FrameNavigationController(rootViewController: WebPageController(url: url, navigator: navigator))
        signedOut = stack
        setTabBarVisible(false)
        show(stack)
    }

    // MARK: Signed in

    /// A page (the one on top, or one that has just loaded and is on top) says what the bar should be.
    func apply(_ newState: FrameState, from page: WebPageController) {
        guard newState.signedIn, !newState.bar.isEmpty else { return }
        let first = self.state == nil || signedOut != nil
        FrameLog.event("state from \(page.url.path): unread \(newState.unread), first \(first)")
        self.state = newState
        FrameStore.save(newState)
        NativeMessages.shared.signedIn(frame: self)

        if first, let stack = page.navigationController as? FrameNavigationController, stack === signedOut {
            enterSignedIn(newState, adopting: page, from: stack)
            return
        }
        rebuildBar()
        selectItem(forPageIn: page.navigationController)
        updateBadge(newState.unread)
        openPendingPath()
    }

    /// The first page after sign-in arrives in the sign-in stack. If it is one of the bar's own pages, it
    /// becomes that tab's first page (no second load); otherwise the first tab opens.
    private func enterSignedIn(_ newState: FrameState, adopting page: WebPageController, from stack: FrameNavigationController) {
        signedOut = nil
        rebuildBar()
        var key = barKeys.first
        if let match = newState.bar.first(where: { Self.sameRoot($0.href, page.webView.url ?? page.url) }) {
            let adopted = match.id
            stack.setViewControllers([UIViewController()], animated: false)
            stacks[adopted] = FrameNavigationController(rootViewController: page, tabKey: adopted)
            key = adopted
        }
        select(key: key ?? barKeys[0])
        updateBadge(newState.unread)
        openPendingPath()
    }

    private static func sameRoot(_ href: String, _ url: URL) -> Bool {
        guard let target = URL(string: href, relativeTo: FrameConfig.baseURL)?.absoluteURL else { return false }
        func path(_ u: URL) -> String { u.path.count > 1 && u.path.hasSuffix("/") ? String(u.path.dropLast()) : u.path }
        return path(target) == path(url) && (target.query ?? "") == (url.query ?? "")
    }

    /// Draws the bar from the latest state. A tab's stack is kept by destination id, so an unchanged tab keeps
    /// its pages when the bar is redrawn (for instance after the person customises it).
    private func rebuildBar() {
        guard let bar = state?.bar else { return }
        if tabBar.items?.map(\.title) == bar.map(\.label) + ["Menu"] { setTabBarVisible(true); updateBadge(state?.unread ?? 0); return }
        FrameLog.event("bar: \(bar.map(\.label).joined(separator: ", ")), Menu")
        barKeys = bar.map(\.id)
        var items: [UITabBarItem] = []
        for (index, destination) in bar.enumerated() {
            items.append(UITabBarItem(title: destination.label, image: Symbols.image(for: destination.icon), tag: index))
        }
        items.append(UITabBarItem(title: "Menu", image: Symbols.image(for: "menu"), tag: Self.menuTag))
        tabBar.setItems(items, animated: false)
        setTabBarVisible(true)
        updateBadge(state?.unread ?? 0)
    }

    private func updateBadge(_ unread: Int) {
        guard let bar = state?.bar, let items = tabBar.items else { return }
        let count = nativeMessagesUnread ?? unread
        for (index, destination) in bar.enumerated() where index < items.count {
            items[index].badgeValue = destination.id == "messages" && count > 0 ? (count > 99 ? "99+" : "\(count)") : nil
        }
    }

    /// The native Messages screens counted unread messages (nil: signed out).
    func setMessagesUnread(_ count: Int?) {
        nativeMessagesUnread = count
        updateBadge(state?.unread ?? 0)
    }

    /// Highlights the tab for the stack the page is in, or none if the page is in a stack that is not on this bar.
    private func selectItem(forPageIn navigation: UINavigationController?) {
        guard let items = tabBar.items else { return }
        if let key = (navigation as? FrameNavigationController)?.tabKey, let index = barKeys.firstIndex(of: key), index < items.count {
            tabBar.selectedItem = items[index]
        } else {
            tabBar.selectedItem = nil
        }
    }

    private func stack(forKey key: String) -> FrameNavigationController {
        if let existing = stacks[key] { return existing }
        let destination = state?.bar.first { $0.id == key }
        let url = destination.flatMap { URL(string: $0.href, relativeTo: FrameConfig.baseURL)?.absoluteURL } ?? FrameConfig.baseURL
        // Messages is a native screen; every other tab is the website's page.
        let root: UIViewController = key == "messages" && NativeMessages.shared.isEnabled
            ? NativeMessages.shared.makeList(navigator: navigator)
            : WebPageController(url: url, navigator: navigator)
        let created = FrameNavigationController(rootViewController: root, tabKey: key)
        stacks[key] = created
        return created
    }

    private func select(key: String) {
        FrameStore.saveLastKey(key)
        show(stack(forKey: key))
        selectItem(forPageIn: content)
    }

    /// The page on top of a stack has become visible: the bar follows it.
    func pageDidAppear(_ page: WebPageController) {
        if let reported = page.reportedState, signedOut == nil { apply(reported, from: page) }
    }

    // MARK: Tab bar

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        if item.tag == Self.menuTag {
            selectItem(forPageIn: content) // Menu is not a place; the tab stays highlighted
            presentMenu()
            return
        }
        guard item.tag >= 0, item.tag < barKeys.count else { return }
        let key = barKeys[item.tag]
        FrameLog.event("tab selected: \(key)")
        Haptics.play("selection")
        if stacks[key] === content {
            // Tapping the tab you are on: back to its first page, or to the top of it.
            if content.viewControllers.count > 1 {
                content.popToRootViewController(animated: true)
            } else if let page = content.viewControllers.first as? WebPageController {
                page.scrollToTop()
            }
        } else {
            select(key: key)
        }
    }

    private func presentMenu() {
        guard let state else { return }
        FrameLog.event("menu opened")
        let menu = MenuController(state: state)
        menu.onDestination = { [weak self] destination in self?.open(destination) }
        menu.onAction = { [weak self] action in self?.run(action) }
        let navigation = FrameNavigationController(rootViewController: menu, style: .cream)
        navigation.modalPresentationStyle = .pageSheet
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        topPresenter.present(navigation, animated: true)
    }

    /// A Menu item: switch to its tab if it is on the bar, otherwise open it on top of where you are.
    private func open(_ destination: FrameDestination) {
        FrameLog.event("menu item \(destination.id)")
        if state?.bar.contains(where: { $0.id == destination.id }) == true {
            select(key: destination.id)
            if content.viewControllers.count > 1 { content.popToRootViewController(animated: false) }
        } else if let url = URL(string: destination.href, relativeTo: FrameConfig.baseURL)?.absoluteURL {
            navigator.open(url, from: currentPage)
        }
    }

    func run(_ action: MenuController.Action) {
        guard let page = currentPage else { return }
        FrameLog.event("menu action \(action.rawValue)")
        Bridge.emit("action", payload: ["name": action.rawValue], in: page.webView)
    }

    // MARK: Push

    /// A notification was tapped. Waits for the frame to be signed in (a cold launch), then opens the page over
    /// whatever tab is showing.
    private var pendingPath: String?

    func openFromPush(_ path: String) {
        FrameLog.event("push tap: \(path)")
        pendingPath = path
        openPendingPath()
    }

    private func openPendingPath() {
        guard let path = pendingPath, isSignedIn else { return }
        pendingPath = nil
        navigator.open(FrameConfig.url(forPath: path), from: currentPage)
    }

    /// Firebase rotated the token: the page on screen re-registers it (lib/push.ts refreshNativeToken).
    func tokenChanged(_ token: String) {
        guard let page = currentPage else { return }
        Bridge.emit("pushToken", payload: ["token": token], in: page.webView)
    }

    /// Whether anyone is signed in (a bar is showing, or one was remembered from last time).
    var isSignedIn: Bool { signedOut == nil && state != nil }

    /// A link to the Messages page (or `?c=<conversation>`), opened natively: on the Messages tab when it is on the bar,
    /// otherwise over the tab on screen. Returns false for anything else, and for `web=1` (the website's own page).
    func openMessagesIfNative(_ url: URL) -> Bool {
        guard url.path == "/family-village/messages" || url.path == "/family-village/messages/" else { return false }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if items.contains(where: { $0.name == "web" }) { return false }
        let conversation = items.first { $0.name == "c" }?.value
        if state?.bar.contains(where: { $0.id == "messages" }) == true {
            select(key: "messages")
            if content.viewControllers.count > 1 { content.popToRootViewController(animated: false) }
        } else {
            content.pushViewController(NativeMessages.shared.makeList(navigator: navigator), animated: true)
        }
        if let conversation { NativeMessages.shared.open(conversationId: conversation, in: content, navigator: navigator) }
        return true
    }

    /// The page on top of the stack on screen.
    var currentPage: WebPageController? { content.topViewController as? WebPageController }

    // MARK: Navigation bar buttons

    /// The profile button's menu in the header.
    func profileMenu() -> UIMenu {
        UIMenu(children: [
            UIAction(title: "Account & security", image: UIImage(systemName: "person.crop.circle")) { [weak self] _ in self?.run(.account) },
            UIAction(title: "Customize bottom bar", image: UIImage(systemName: "slider.horizontal.3")) { [weak self] _ in self?.run(.customize) },
            UIAction(title: "Take the tour", image: UIImage(systemName: "questionmark.circle")) { [weak self] _ in self?.run(.tour) },
            UIAction(title: "Sign out", image: UIImage(systemName: "rectangle.portrait.and.arrow.right"), attributes: .destructive) { [weak self] _ in self?.run(.signOut) },
        ])
    }

    func openNotifications(from page: WebPageController?) {
        navigator.open(FrameConfig.url(forPath: "/family-village/notifications"), from: page ?? currentPage)
    }

    func setNotificationUnread(_ count: Int) {
        guard count != notificationUnread else { return }
        notificationUnread = count
        for stack in stacks.values {
            for case let page as ChromeRefreshing in stack.viewControllers { page.refreshChrome() }
        }
    }

    // MARK: Layout

    private func setTabBarVisible(_ visible: Bool) {
        tabBar.isHidden = !visible
        containerBottomToTabBar.isActive = visible
        containerBottomToView.isActive = !visible
    }

    private func show(_ stack: FrameNavigationController) {
        if content === stack, stack.parent === self { return }
        if let old = content, old.parent === self {
            old.willMove(toParent: nil)
            old.view.removeFromSuperview()
            old.removeFromParent()
        }
        content = stack
        addChild(stack)
        stack.view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack.view)
        NSLayoutConstraint.activate([
            stack.view.topAnchor.constraint(equalTo: container.topAnchor),
            stack.view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            stack.view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        stack.didMove(toParent: self)
        setNeedsStatusBarAppearanceUpdate()
    }

    /// The view controller that should present something new: the top of whatever is already presented.
    var topPresenter: UIViewController {
        var top: UIViewController = self
        while let next = top.presentedViewController { top = next }
        return top
    }
}

/// What the frame remembers between launches, so it can open into the tab bar without waiting for a page.
enum FrameStore {
    private static let stateKey = "frame.state"
    private static let tabKey = "frame.lastKey"

    static func save(_ state: FrameState) {
        if let data = try? JSONEncoder().encode(state) { UserDefaults.standard.set(data, forKey: stateKey) }
    }

    static func loadState() -> FrameState? {
        guard let data = UserDefaults.standard.data(forKey: stateKey) else { return nil }
        return try? JSONDecoder().decode(FrameState.self, from: data)
    }

    static func saveLastKey(_ key: String) { UserDefaults.standard.set(key, forKey: tabKey) }
    static func lastKey() -> String? { UserDefaults.standard.string(forKey: tabKey) }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: stateKey)
        UserDefaults.standard.removeObject(forKey: tabKey)
    }
}
