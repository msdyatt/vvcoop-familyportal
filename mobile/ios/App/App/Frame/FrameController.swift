import UIKit

/// The app's root screen.
///
/// Signed out: one navigation stack holding the sign-in page, no tab bar.
/// Signed in: a native tab bar under a navigation stack per tab. Which tabs there are is whatever the
/// page last told us (`FrameState`, from the person's own choices); the last item is always Menu.
///
/// The bar always follows the page on top: when a page appears, the state it reported is applied. So a
/// page that belongs to another section (a Teacher page opened from Family home) shows that section's
/// bar, and going back restores the previous one.
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

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var childForStatusBarStyle: UIViewController? { content }

    // MARK: Setup

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Brand.cream

        container.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(container)

        tabBar.translatesAutoresizingMaskIntoConstraints = false
        tabBar.delegate = self
        tabBar.tintColor = Brand.navy
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

        if let cached = FrameStore.loadState(), cached.signedIn, let section = cached.currentSection, !section.bar.isEmpty {
            // Open straight into the bar they had last time. If the session is gone, the page redirects to
            // sign-in and the frame goes back to signed-out.
            state = cached
            rebuildBar(for: section)
            select(key: FrameStore.lastKey().flatMap { barKeys.contains($0) ? $0 : nil } ?? barKeys[0])
        } else {
            showSignedOut(FrameConfig.startURL)
        }
    }

    // MARK: Signed out

    /// Starts over from one page (the sign-in screen): drops every stack, the tab bar and what was remembered.
    func showRoot(_ url: URL) {
        if presentedViewController != nil { dismiss(animated: false) }
        showSignedOut(url)
    }

    private func showSignedOut(_ url: URL) {
        FrameLog.event("signed out: sign-in page \(url.path)")
        stacks.removeAll()
        barKeys.removeAll()
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
        guard newState.signedIn, let section = newState.currentSection else { return }
        let first = self.state == nil || signedOut != nil
        FrameLog.event("state from \(page.url.path): section \(newState.section), unread \(newState.unread), first \(first)")
        self.state = newState
        FrameStore.save(newState)

        if first, let stack = page.navigationController as? FrameNavigationController, stack === signedOut {
            enterSignedIn(newState, section: section, adopting: page, from: stack)
            return
        }
        rebuildBar(for: section)
        selectItem(forPageIn: page.navigationController)
        updateBadge(newState.unread)
    }

    /// The first page after sign-in arrives in the sign-in stack. If it is one of the bar's own pages, it
    /// becomes that tab's first page (no second load); otherwise the first tab opens.
    private func enterSignedIn(_ newState: FrameState, section: FrameSection, adopting page: WebPageController, from stack: FrameNavigationController) {
        signedOut = nil
        rebuildBar(for: section)
        var key = barKeys.first
        if let match = section.bar.first(where: { Self.sameRoot($0.href, page.webView.url ?? page.url) }) {
            let adopted = "\(section.id)/\(match.id)"
            stack.setViewControllers([UIViewController()], animated: false)
            stacks[adopted] = FrameNavigationController(rootViewController: page, tabKey: adopted)
            key = adopted
        }
        select(key: key ?? barKeys[0])
        updateBadge(newState.unread)
    }

    private static func sameRoot(_ href: String, _ url: URL) -> Bool {
        guard let target = URL(string: href, relativeTo: FrameConfig.baseURL)?.absoluteURL else { return false }
        func path(_ u: URL) -> String { u.path.count > 1 && u.path.hasSuffix("/") ? String(u.path.dropLast()) : u.path }
        return path(target) == path(url) && (target.query ?? "") == (url.query ?? "")
    }

    private func rebuildBar(for section: FrameSection) {
        FrameLog.event("bar [\(section.id)]: \(section.bar.map(\.label).joined(separator: ", ")), Menu")
        barKeys = section.bar.map { "\(section.id)/\($0.id)" }
        var items: [UITabBarItem] = []
        for (index, destination) in section.bar.enumerated() {
            items.append(UITabBarItem(title: destination.label, image: Symbols.image(for: destination.icon), tag: index))
        }
        items.append(UITabBarItem(title: "Menu", image: Symbols.image(for: "menu"), tag: Self.menuTag))
        tabBar.setItems(items, animated: false)
        setTabBarVisible(true)
        updateBadge(state?.unread ?? 0)
    }

    private func updateBadge(_ unread: Int) {
        guard let section = state?.currentSection, let items = tabBar.items else { return }
        for (index, destination) in section.bar.enumerated() where index < items.count {
            items[index].badgeValue = destination.id == "messages" && unread > 0 ? (unread > 99 ? "99+" : "\(unread)") : nil
        }
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
        let parts = key.split(separator: "/", maxSplits: 1).map(String.init)
        let destination = state?.sections.first { $0.id == parts[0] }?.bar.first { $0.id == parts.last }
        let url = destination.flatMap { URL(string: $0.href, relativeTo: FrameConfig.baseURL)?.absoluteURL } ?? FrameConfig.baseURL
        let created = FrameNavigationController(rootViewController: WebPageController(url: url, navigator: navigator), tabKey: key)
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

    /// A Menu item: switch to its tab if it is on the bar of its section, otherwise open it on top of where you are.
    private func open(_ destination: FrameDestination) {
        guard let state else { return }
        let target = destination.section ?? state.section
        FrameLog.event("menu item \(destination.id) (section \(target))")
        if let section = state.sections.first(where: { $0.id == target }), section.bar.contains(where: { $0.id == destination.id }) {
            self.state = state.withSection(target)
            rebuildBar(for: section)
            select(key: "\(target)/\(destination.id)")
            if content.viewControllers.count > 1 { content.popToRootViewController(animated: false) }
        } else if let url = URL(string: destination.href, relativeTo: FrameConfig.baseURL)?.absoluteURL {
            navigator.open(url, from: currentPage)
        }
    }

    private func run(_ action: MenuController.Action) {
        guard let page = currentPage else { return }
        FrameLog.event("menu action \(action.rawValue)")
        Bridge.emit("action", payload: ["name": action.rawValue], in: page.webView)
    }

    /// The page on top of the stack on screen.
    var currentPage: WebPageController? { content.topViewController as? WebPageController }

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
