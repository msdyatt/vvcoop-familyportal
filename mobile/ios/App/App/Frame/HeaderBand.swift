import UIKit

/// The colours of a section's header, taken from the web's `--portal-band-*` variables (app/globals.css):
/// Family and Teaching (one portal, one look) are the cream page with a terracotta rule, and Admin a navy band
/// with a light terracotta rule.
struct HeaderTheme {
    let background: UIColor
    let foreground: UIColor
    let rule: UIColor
    let logo: String
    /// Whether the band is dark, so the clock above it is drawn light.
    var isDark: Bool { logo == "LockupCream" }

    static let family = HeaderTheme(background: Brand.canvas, foreground: Brand.ink, rule: Brand.terracotta, logo: "LockupNavy")  // LockupNavy has a cream variant for dark
    static let admin = HeaderTheme(
        background: Brand.band, foreground: Brand.cream,
        rule: UIColor(red: 0xD7 / 255, green: 0xA5 / 255, blue: 0x90 / 255, alpha: 1), logo: "LockupCream")

    /// `name` is what the page's header says it belongs to ("home", "teacher", "admin"); without it, the path decides.
    static func resolve(name: String?, path: String) -> HeaderTheme {
        switch name {
        case "admin": return .admin
        case "home", "teacher": return .family
        default:
            if path.hasPrefix("/family-village/admin") { return .admin }
            return .family
        }
    }
}

/// The header of every signed-in page: the logo, the notification bell and the profile button on one row, and
/// the page's name under them in the serif, like the website's header in the app (platform.css). It replaces
/// the system navigation bar on those pages.
final class HeaderBandView: UIView {
    var onBack: (() -> Void)?
    var onBell: (() -> Void)?

    private let back = UIButton(type: .system)
    private let logo = UIImageView()
    private let bell = UIButton(type: .system)
    private let profile = UIButton(type: .system)
    private let titleLabel = UILabel()
    private let rule = UIView()
    /// What the bell was last drawn for, so it can be drawn again when Light/Dark changes: its image is a bitmap with
    /// the colour baked in, which a dynamic colour cannot re-colour by itself.
    private var bellState: (unread: Int, ink: UIColor)?

    override init(frame: CGRect) {
        super.init(frame: frame)

        logo.contentMode = .scaleAspectFit
        logo.setContentHuggingPriority(.defaultLow, for: .horizontal)
        logo.accessibilityLabel = "Veritas Village"
        logo.isAccessibilityElement = true

        back.setImage(UIImage(systemName: "chevron.backward", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)), for: .normal)
        back.accessibilityLabel = "Back"
        back.addAction(UIAction { [weak self] _ in self?.onBack?() }, for: .touchUpInside)
        bell.addAction(UIAction { [weak self] _ in self?.onBell?() }, for: .touchUpInside)
        bell.accessibilityLabel = "Notifications"
        profile.setImage(UIImage(systemName: "person.crop.circle", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .regular)), for: .normal)
        profile.accessibilityLabel = "Account"
        profile.showsMenuAsPrimaryAction = true

        for button in [back, bell, profile] {
            button.layer.cornerRadius = 20
            button.layer.borderWidth = 1
            button.translatesAutoresizingMaskIntoConstraints = false
            button.widthAnchor.constraint(equalToConstant: 40).isActive = true
            button.heightAnchor.constraint(equalToConstant: 40).isActive = true
        }

        let spacer = UIView()
        spacer.setContentHuggingPriority(.defaultLow - 1, for: .horizontal)
        let row = UIStackView(arrangedSubviews: [back, logo, spacer, bell, profile])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 10
        logo.translatesAutoresizingMaskIntoConstraints = false
        logo.widthAnchor.constraint(equalToConstant: 140).isActive = true
        logo.heightAnchor.constraint(equalToConstant: 48).isActive = true

        titleLabel.font = Self.serif(size: 24)
        titleLabel.adjustsFontSizeToFitWidth = true
        titleLabel.minimumScaleFactor = 0.75
        titleLabel.accessibilityTraits = .header

        let column = UIStackView(arrangedSubviews: [row, titleLabel])
        column.axis = .vertical
        column.spacing = 4
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)

        rule.translatesAutoresizingMaskIntoConstraints = false
        addSubview(rule)

        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            rule.leadingAnchor.constraint(equalTo: leadingAnchor),
            rule.trailingAnchor.constraint(equalTo: trailingAnchor),
            rule.bottomAnchor.constraint(equalTo: bottomAnchor),
            rule.heightAnchor.constraint(equalToConstant: 2),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Playfair Display is a web font the app does not carry; the system serif (New York) is the closest native match.
    private static func serif(size: CGFloat) -> UIFont {
        let base = UIFont.systemFont(ofSize: size, weight: .semibold)
        guard let descriptor = base.fontDescriptor.withDesign(.serif) else { return base }
        return UIFont(descriptor: descriptor, size: size)
    }

    func configure(theme: HeaderTheme, title: String?, showBack: Bool, showActions: Bool, unread: Int, menu: UIMenu) {
        backgroundColor = theme.background
        rule.backgroundColor = theme.rule
        logo.image = UIImage(named: theme.logo)
        titleLabel.text = title
        titleLabel.textColor = theme.foreground
        titleLabel.isHidden = (title ?? "").isEmpty
        back.isHidden = !showBack
        bell.isHidden = !showActions
        profile.isHidden = !showActions
        for button in [back, bell, profile] {
            button.tintColor = theme.foreground
            button.layer.borderColor = theme.rule.cgColor
        }
        bellState = (unread, theme.foreground)
        drawBell()
        bell.accessibilityLabel = unread > 0 ? "Notifications, \(unread) unread" : "Notifications"
        profile.menu = menu
    }

    private func drawBell() {
        guard let state = bellState else { return }
        bell.setImage(BellImage.make(count: state.unread, ink: state.ink.resolvedColor(with: traitCollection)), for: .normal)
    }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        if previous?.userInterfaceStyle != traitCollection.userInterfaceStyle {
            drawBell()
        }
    }
}
