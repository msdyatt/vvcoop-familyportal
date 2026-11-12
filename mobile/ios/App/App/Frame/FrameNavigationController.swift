import UIKit

/// A navigation controller in the app's look (navy bar, light text) whose edge-swipe gives way to
/// the page when the page has something open inside it.
final class FrameNavigationController: UINavigationController, UINavigationControllerDelegate {
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
    /// own top: a status strip, and on signed-in pages the section header (HeaderBand.swift).
    var isSheet: Bool { style == .cream }

    /// The finger-driven back swipe, while one is in progress.
    private var swipe: UIPercentDrivenInteractiveTransition?

    override func viewDidLoad() {
        super.viewDidLoad()
        isNavigationBarHidden = !isSheet
        delegate = self

        // The system's back-swipe is switched off: with the system bar hidden UIKit drops it unpredictably. The frame has its own,
        // from the left edge, which also knows that a popup or inner screen is closed before the page is.
        interactivePopGestureRecognizer?.isEnabled = false
        let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgeSwiped(_:)))
        edge.edges = .left
        view.addGestureRecognizer(edge)

        let foreground = style == .navy ? Brand.cream : Brand.ink
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = style == .navy ? Brand.band : Brand.canvas
        appearance.shadowColor = .clear
        appearance.titleTextAttributes = [.foregroundColor: foreground, .font: UIFont.systemFont(ofSize: 17, weight: .semibold)]
        navigationBar.standardAppearance = appearance
        navigationBar.scrollEdgeAppearance = appearance
        navigationBar.compactAppearance = appearance
        navigationBar.tintColor = foreground
        navigationBar.barStyle = style == .navy ? .black : .default
    }

    @objc private func edgeSwiped(_ gesture: UIScreenEdgePanGestureRecognizer) {
        FrameLog.event("nav edge swipe state=\(gesture.state.rawValue) x=\(Int(gesture.translation(in: view).x))")
        let width = max(view.bounds.width, 1)
        let progress = min(1, max(0, gesture.translation(in: view).x / width))
        switch gesture.state {
        case .began:
            // A page with a popup, report or tab open closes that first (WebPageController handles that swipe).
            guard viewControllers.count > 1, !((topViewController as? WebPageController)?.hasInPageHistory ?? false) else { return }
            FrameLog.event("back-swipe: leaving the page")
            swipe = UIPercentDrivenInteractiveTransition()
            popViewController(animated: true)
        case .changed:
            swipe?.update(progress)
        case .ended, .cancelled, .failed:
            guard let swipe else { return }
            self.swipe = nil
            if gesture.state == .ended, progress > 0.35 || gesture.velocity(in: view).x > 700 {
                Haptics.play("selection")
                swipe.finish()
            } else {
                swipe.cancel()
            }
        default: break
        }
    }

    /// Pages choose their own clock colour (it depends on the header's colour); sheets use the bar's.
    override var childForStatusBarStyle: UIViewController? { isSheet ? nil : topViewController }

    override var preferredStatusBarStyle: UIStatusBarStyle { style == .navy ? .lightContent : .default }

    // MARK: Transition

    func navigationController(_ navigationController: UINavigationController, animationControllerFor operation: UINavigationController.Operation,
                              from fromVC: UIViewController, to toVC: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        // Only the finger-driven pop is ours; a button press or a push gets UIKit's own slide.
        operation == .pop && swipe != nil ? SlideBackAnimator() : nil
    }

    func navigationController(_ navigationController: UINavigationController,
                              interactionControllerFor animationController: UIViewControllerAnimatedTransitioning) -> UIViewControllerInteractiveTransitioning? {
        swipe
    }
}

/// The page slides away to the right over the one beneath, which drifts in from the left.
private final class SlideBackAnimator: NSObject, UIViewControllerAnimatedTransitioning {
    func transitionDuration(using transitionContext: UIViewControllerContextTransitioning?) -> TimeInterval { 0.3 }

    func animateTransition(using context: UIViewControllerContextTransitioning) {
        guard let from = context.viewController(forKey: .from), let to = context.viewController(forKey: .to) else {
            context.completeTransition(false)
            return
        }
        let container = context.containerView
        let width = container.bounds.width
        to.view.frame = context.finalFrame(for: to)
        to.view.transform = CGAffineTransform(translationX: -width * 0.3, y: 0)
        container.insertSubview(to.view, belowSubview: from.view)

        from.view.layer.shadowColor = UIColor.black.cgColor
        from.view.layer.shadowOpacity = 0.18
        from.view.layer.shadowRadius = 8

        UIView.animate(withDuration: transitionDuration(using: context), delay: 0, options: .curveLinear, animations: {
            from.view.transform = CGAffineTransform(translationX: width, y: 0)
            to.view.transform = .identity
        }, completion: { _ in
            from.view.transform = .identity
            from.view.layer.shadowOpacity = 0
            to.view.transform = .identity
            context.completeTransition(!context.transitionWasCancelled)
        })
    }
}
