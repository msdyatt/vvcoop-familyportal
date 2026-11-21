import UIKit

/// The loading screen: the co-op's mark and name on navy, with the ink loading animation under them, shown from launch until the first
/// page has loaded. It is laid out exactly like the system launch screen (Base.lproj/LaunchScreen.storyboard), so the two
/// read as one screen, and it replaces the web launch page the old Capacitor app showed. If the first page cannot load,
/// the page's own "Can't reach Veritas Village" screen takes over.
final class SplashView: UIView {
    private let loading = InkLoadingView(style: .onNavy)

    init() {
        super.init(frame: .zero)
        backgroundColor = Brand.navy

        let mark = UIImageView(image: UIImage(named: "SplashMark"))
        mark.contentMode = .scaleAspectFit
        mark.translatesAutoresizingMaskIntoConstraints = false

        let title = UILabel()
        title.text = "Veritas Village"
        title.font = UIFont(name: "Georgia-Bold", size: 22) ?? UIFont.systemFont(ofSize: 22, weight: .bold)
        title.textColor = Brand.cream
        title.textAlignment = .center
        title.translatesAutoresizingMaskIntoConstraints = false

        // The same animation the pages show while they open, so it is always clear the app is working.
        let status = loading
        status.initialCaption = "Opening your portal…"
        status.translatesAutoresizingMaskIntoConstraints = false

        addSubview(mark)
        addSubview(title)
        addSubview(status)
        NSLayoutConstraint.activate([
            mark.centerXAnchor.constraint(equalTo: centerXAnchor),
            mark.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -22),
            mark.widthAnchor.constraint(equalToConstant: 96),
            mark.heightAnchor.constraint(equalToConstant: 96),
            title.centerXAnchor.constraint(equalTo: centerXAnchor),
            title.topAnchor.constraint(equalTo: mark.bottomAnchor, constant: 14),
            status.leadingAnchor.constraint(equalTo: leadingAnchor),
            status.trailingAnchor.constraint(equalTo: trailingAnchor),
            status.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 14),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { loading.start() } else { loading.stop() }
    }
}
