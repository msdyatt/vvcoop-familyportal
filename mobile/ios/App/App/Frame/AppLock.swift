import LocalAuthentication
import UIKit

/// Face ID (or the device passcode) when the person comes back to the app.
///
/// Locks only when someone is signed in, the setting is on, and the app was away for a while (or has
/// just been launched). The app's content is covered the moment it stops being active, so it does
/// not show in the app switcher either. A phone with no passcode set cannot be locked, so it is not.
final class AppLock {
    static let shared = AppLock()

    private static let enabledKey = "appLock.enabled"
    /// How long the app can be away before it asks again.
    private let grace: TimeInterval = 30

    /// Whether the lock is switched on (the Menu has the switch). On unless the person turned it off.
    var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: Self.enabledKey) == nil ? true : UserDefaults.standard.bool(forKey: Self.enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey) }
    }

    var canLock: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }

    /// Set by the frame: whether anyone is signed in right now.
    var isSignedIn: () -> Bool = { false }

    private weak var window: UIWindow?
    private var cover: LockView?
    private var leftAt: Date? = .distantPast // a fresh launch counts as having been away
    private var evaluating = false

    func attach(to window: UIWindow) { self.window = window }

    func willResignActive() {
        guard isSignedIn(), isEnabled else { return }
        showCover(locked: false)
    }

    func didEnterBackground() { leftAt = Date() }

    func didBecomeActive() {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "VVLockDemo") { showCover(locked: true); return }
        #endif
        // Time away is measured from the last trip to the background (or from launch). A system alert, the
        // share sheet or the Face ID prompt itself make the app inactive without leaving it, and must not lock.
        let away = leftAt.map { Date().timeIntervalSince($0) } ?? 0
        leftAt = nil
        if isSignedIn(), isEnabled, canLock, away >= grace {
            showCover(locked: true)
            unlock()
        } else if cover != nil, !evaluating {
            removeCover()
        }
    }

    private func unlock() {
        guard !evaluating else { return }
        evaluating = true
        let context = LAContext()
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Veritas Village") { [weak self] success, _ in
            DispatchQueue.main.async {
                self?.evaluating = false
                if success { Haptics.play("success"); self?.removeCover() }
            }
        }
    }

    private func showCover(locked: Bool) {
        guard let window else { return }
        if cover == nil {
            let view = LockView()
            view.onUnlock = { [weak self] in self?.unlock() }
            view.frame = window.bounds
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            window.addSubview(view)
            cover = view
        }
        cover?.setLocked(locked)
    }

    private func removeCover() {
        UIView.animate(withDuration: 0.2, animations: { self.cover?.alpha = 0 }, completion: { _ in
            self.cover?.removeFromSuperview()
            self.cover = nil
        })
    }
}

/// What covers the app while it is inactive or locked.
final class LockView: UIView {
    var onUnlock: (() -> Void)?
    private let button: UIButton

    override init(frame: CGRect) {
        var configuration = UIButton.Configuration.filled()
        configuration.title = "Unlock"
        configuration.image = UIImage(systemName: "faceid")
        configuration.imagePadding = 8
        configuration.baseBackgroundColor = Brand.cream
        configuration.baseForegroundColor = Brand.navy
        configuration.cornerStyle = .capsule
        button = UIButton(configuration: configuration)
        super.init(frame: frame)
        backgroundColor = Brand.navy

        let title = UILabel()
        title.text = "Veritas Village"
        title.font = UIFont.systemFont(ofSize: 26, weight: .semibold)
        title.textColor = Brand.cream

        button.addAction(UIAction { [weak self] _ in self?.onUnlock?() }, for: .touchUpInside)
        button.isHidden = true

        let stack = UIStackView(arrangedSubviews: [title, button])
        stack.axis = .vertical
        stack.spacing = 24
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Locked shows the Unlock button (for when the prompt was cancelled); otherwise it is just a cover.
    func setLocked(_ locked: Bool) { button.isHidden = !locked }
}
