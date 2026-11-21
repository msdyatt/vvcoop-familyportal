import UIKit

/// The loading animation: three ink diamonds that hop in turn above a hand-drawn line that inks itself in, with a
/// short caption. The same drawing as the website's page placeholder (app/family-village/page-skeleton.tsx), so moving
/// between a native screen and a web page reads as one app.
///
/// Used over a page while it opens (WebPageController) and on the launch screen (SplashView). With Reduce Motion on, the
/// diamonds only fade gently and the line is drawn already. The caption changes if a load runs long, so it is always
/// clear that something is happening.
final class InkLoadingView: UIView {
    enum Style { case onCanvas, onNavy }

    private let style: Style
    private let diamonds: [CAShapeLayer] = (0..<3).map { _ in CAShapeLayer() }
    private let line = CAShapeLayer()
    private let caption = UILabel()
    private let stage = UIView()
    private var captionTimers: [Timer] = []
    private(set) var isRunning = false

    /// The caption first shown; later ones follow if the load is slow.
    var initialCaption = "Loading…"

    init(style: Style) {
        self.style = style
        super.init(frame: .zero)
        isAccessibilityElement = true
        accessibilityTraits = .updatesFrequently
        backgroundColor = style == .onCanvas ? Brand.canvas : .clear

        stage.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stage)
        for diamond in diamonds { stage.layer.addSublayer(diamond) }
        stage.layer.addSublayer(line)

        caption.font = UIFont.preferredFont(forTextStyle: .subheadline)
        caption.adjustsFontForContentSizeCategory = true
        caption.textAlignment = .center
        caption.numberOfLines = 0
        caption.translatesAutoresizingMaskIntoConstraints = false
        addSubview(caption)

        NSLayoutConstraint.activate([
            stage.centerXAnchor.constraint(equalTo: centerXAnchor),
            stage.widthAnchor.constraint(equalToConstant: 120),
            stage.heightAnchor.constraint(equalToConstant: 44),
            caption.topAnchor.constraint(equalTo: stage.bottomAnchor, constant: 10),
            caption.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
            caption.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -24),
            caption.centerXAnchor.constraint(equalTo: centerXAnchor),
        ])
        // On a page it sits a third of the way down, where the content would start; on the launch screen the
        // launch screen places it.
        if style == .onCanvas {
            stage.topAnchor.constraint(equalTo: topAnchor, constant: 120).isActive = true
        } else {
            stage.topAnchor.constraint(equalTo: topAnchor).isActive = true
            caption.bottomAnchor.constraint(equalTo: bottomAnchor).isActive = true
        }
        applyColors()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Three small diamonds, 10pt across, 22pt apart, over a gently wavy line.
        let size: CGFloat = 10, gap: CGFloat = 22
        let startX = stage.bounds.midX - gap
        for (i, diamond) in diamonds.enumerated() {
            let center = CGPoint(x: startX + CGFloat(i) * gap, y: 14)
            let path = UIBezierPath()
            path.move(to: CGPoint(x: center.x, y: center.y - size / 2))
            path.addLine(to: CGPoint(x: center.x + size / 2, y: center.y))
            path.addLine(to: CGPoint(x: center.x, y: center.y + size / 2))
            path.addLine(to: CGPoint(x: center.x - size / 2, y: center.y))
            path.close()
            diamond.path = path.cgPath
        }
        let wave = UIBezierPath()
        let y: CGFloat = 36, w = stage.bounds.width
        wave.move(to: CGPoint(x: 4, y: y))
        wave.addCurve(to: CGPoint(x: w / 2, y: y - 1), controlPoint1: CGPoint(x: w * 0.2, y: y - 5), controlPoint2: CGPoint(x: w * 0.32, y: y + 4))
        wave.addCurve(to: CGPoint(x: w - 4, y: y - 3), controlPoint1: CGPoint(x: w * 0.68, y: y - 5), controlPoint2: CGPoint(x: w * 0.82, y: y + 2))
        line.path = wave.cgPath
        line.fillColor = UIColor.clear.cgColor
        line.lineWidth = 1.6
        line.lineCap = .round
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        applyColors()
    }

    private func applyColors() {
        let mark = style == .onCanvas ? Brand.terracotta : Brand.accentOnInk
        let ink = style == .onCanvas ? Brand.ink : Brand.cream
        for diamond in diamonds { diamond.fillColor = mark.resolvedColor(with: traitCollection).cgColor }
        line.strokeColor = ink.withAlphaComponent(0.55).resolvedColor(with: traitCollection).cgColor
        caption.textColor = style == .onCanvas ? Brand.ink.withAlphaComponent(0.75) : UIColor(red: 0xBB / 255, green: 0xC0 / 255, blue: 0xB8 / 255, alpha: 1)
    }

    /// Starts the animation and the caption's timeline. Safe to call when already running.
    func start() {
        guard !isRunning else { return }
        isRunning = true
        layoutIfNeeded()
        setCaption(initialCaption, announce: false)
        captionTimers = [
            Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in self?.setCaption("Still working on it…") },
            Timer.scheduledTimer(withTimeInterval: 9, repeats: false) { [weak self] _ in
                self?.setCaption("This is taking longer than usual. Pull down to try again.")
            },
        ]
        if UIAccessibility.isReduceMotionEnabled {
            line.strokeEnd = 1
            for (i, diamond) in diamonds.enumerated() {
                let fade = CABasicAnimation(keyPath: "opacity")
                fade.fromValue = 0.35
                fade.toValue = 1
                fade.duration = 1.2
                fade.beginTime = CACurrentMediaTime() + Double(i) * 0.3
                fade.autoreverses = true
                fade.repeatCount = .infinity
                diamond.add(fade, forKey: "fade")
            }
            return
        }
        for (i, diamond) in diamonds.enumerated() {
            let hop = CAKeyframeAnimation(keyPath: "transform.translation.y")
            hop.values = [0, -9, 0, 0]
            hop.keyTimes = [0, 0.18, 0.36, 1]
            hop.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeIn), CAMediaTimingFunction(name: .linear)]
            hop.duration = 1.2
            hop.beginTime = CACurrentMediaTime() + Double(i) * 0.15
            hop.repeatCount = .infinity
            diamond.add(hop, forKey: "hop")
        }
        let draw = CABasicAnimation(keyPath: "strokeEnd")
        draw.fromValue = 0
        draw.toValue = 1
        draw.duration = 1.2
        draw.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        fade.beginTime = 1.4
        fade.duration = 0.4
        let ink = CAAnimationGroup()
        ink.animations = [draw, fade]
        ink.duration = 1.9
        ink.repeatCount = .infinity
        line.add(ink, forKey: "ink")
    }

    /// Stops everything; the view can be started again later.
    func stop() {
        isRunning = false
        for timer in captionTimers { timer.invalidate() }
        captionTimers = []
        for diamond in diamonds { diamond.removeAllAnimations() }
        line.removeAllAnimations()
    }

    /// A slow load is announced to VoiceOver; the first "Loading…" is not, or every page would speak.
    private func setCaption(_ text: String, announce: Bool = true) {
        caption.text = text
        accessibilityLabel = text
        if announce, isRunning, !isHidden, alpha > 0 { UIAccessibility.post(notification: .announcement, argument: text) }
    }
}
