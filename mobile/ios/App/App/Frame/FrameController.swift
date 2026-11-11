import UIKit

/// The app's root screen. Holds the navigation stack the person is in and everything presented over
/// it. (The tab bar joins here once the signed-in frame is built; today there is one stack.)
final class FrameController: UIViewController {
    private(set) lazy var navigator = Navigator(frame: self)
    private(set) var content: FrameNavigationController!

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var childForStatusBarStyle: UIViewController? { content }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Brand.navy
        content = FrameNavigationController(rootViewController: WebPageController(url: FrameConfig.startURL, navigator: navigator))
        addChild(content)
        content.view.frame = view.bounds
        content.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(content.view)
        content.didMove(toParent: self)
    }

    /// Starts over from one page: used for the sign-in screen, so signing out leaves nothing behind.
    func showRoot(_ url: URL) {
        if presentedViewController != nil { dismiss(animated: false) }
        content.setViewControllers([WebPageController(url: url, navigator: navigator)], animated: false)
    }

    /// The view controller that should present something new: the top of whatever is already presented.
    var topPresenter: UIViewController {
        var top: UIViewController = self
        while let next = top.presentedViewController { top = next }
        return top
    }
}
