import SwiftUI
import UIKit

/// A screen the frame draws and the page does not: it has the same top as a web page (the status strip and, on a tab's
/// first screen, the header band with the logo, bell and profile) with a SwiftUI view below it.
protocol ChromeRefreshing: AnyObject { func refreshChrome() }

final class NativeScreenController: UIViewController, ChromeRefreshing, UIGestureRecognizerDelegate {
    enum Chrome {
        /// The header band with the section's name: the first screen of a tab.
        case band(title: String)
        /// Only the status strip: the screen draws its own header (a conversation).
        case strip
    }

    /// A conversation hides the tab bar so the composer sits above the keyboard and the home indicator, as in the system's own chat apps.
    var hidesTabBar = false
    /// What this screen is about (the conversation's id), so the same one is not pushed twice.
    var subject: String?

    private let chrome: Chrome
    private let content: UIViewController
    private let strip = UIView()
    private let band = HeaderBandView()
    private weak var navigator: Navigator?
    private var statusStyle: UIStatusBarStyle = .default
    override var preferredStatusBarStyle: UIStatusBarStyle { statusStyle }

    init<Content: View>(chrome: Chrome, navigator: Navigator?, @ViewBuilder content: () -> Content) {
        self.chrome = chrome
        self.navigator = navigator
        let hosting = UIHostingController(rootView: content())
        // The hosted view fills the space it is given; it does not ask for a size of its own.
        hosting.sizingOptions = []
        self.content = hosting
        super.init(nibName: nil, bundle: nil)
        navigationItem.backButtonDisplayMode = .minimal
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = MT.surfaceUI
        strip.backgroundColor = Brand.canvas
        strip.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(strip)

        addChild(content)
        content.view.translatesAutoresizingMaskIntoConstraints = false
        content.view.backgroundColor = .clear
        view.addSubview(content.view)
        content.didMove(toParent: self)

        var bottomOfChrome = strip.bottomAnchor
        if case .band = chrome {
            // In a stack so the band takes its own height (as on a web page) instead of sharing the slack with the content.
            let top = UIStackView(arrangedSubviews: [band])
            top.axis = .vertical
            top.setContentHuggingPriority(.required, for: .vertical)
            top.setContentCompressionResistancePriority(.required, for: .vertical)
            top.translatesAutoresizingMaskIntoConstraints = false
            band.onBack = { [weak self] in self?.navigationController?.popViewController(animated: true) }
            band.onBell = { [weak self] in self?.navigator?.chromeSource?.openNotifications(from: nil) }
            view.addSubview(top)
            NSLayoutConstraint.activate([
                top.topAnchor.constraint(equalTo: strip.bottomAnchor),
                top.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                top.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            ])
            bottomOfChrome = top.bottomAnchor
            // The band has no height of its own to ask for; a weak pull toward zero makes it take the smallest height its
            // contents allow, so the slack goes to the screen below it.
            let snug = top.heightAnchor.constraint(equalToConstant: 0)
            snug.priority = .defaultLow
            snug.isActive = true
        }
        NSLayoutConstraint.activate([
            strip.topAnchor.constraint(equalTo: view.topAnchor),
            strip.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            strip.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            strip.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            content.view.topAnchor.constraint(equalTo: bottomOfChrome),
            content.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            content.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            content.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        refreshChrome()
    }

    func refreshChrome() {
        guard isViewLoaded, case .band(let title) = chrome, let frame = navigator?.chromeSource else { return }
        let stack = navigationController as? FrameNavigationController
        band.configure(
            theme: .family, title: title,
            showBack: stack?.viewControllers.first !== self,
            showActions: stack?.tabKey != nil,
            unread: frame.notificationUnread,
            menu: frame.profileMenu())
    }
}
