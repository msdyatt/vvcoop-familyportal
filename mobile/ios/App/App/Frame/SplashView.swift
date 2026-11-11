import UIKit

/// The loading screen: the co-op's mark and name on navy, with a short line under them, shown from launch until the first
/// page has loaded. It is laid out exactly like the system launch screen (Base.lproj/LaunchScreen.storyboard), so the two
/// read as one screen, and it replaces the web launch page the old Capacitor app showed. If the first page cannot load,
/// the page's own "Can't reach Veritas Village" screen takes over.
final class SplashView: UIView {
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

        let status = UILabel()
        status.text = "Opening your portal…"
        status.font = UIFont.preferredFont(forTextStyle: .body)
        status.textColor = UIColor(red: 0xBB / 255, green: 0xC0 / 255, blue: 0xB8 / 255, alpha: 1)
        status.textAlignment = .center
        status.translatesAutoresizingMaskIntoConstraints = false
        status.accessibilityTraits = .updatesFrequently

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
            status.centerXAnchor.constraint(equalTo: centerXAnchor),
            status.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
