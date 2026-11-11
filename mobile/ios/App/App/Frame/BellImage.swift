import UIKit

/// The notification bell for the navigation bar, with an unread count in a small badge.
///
/// Drawn into an image (not a custom view) so the system's bar button styling cannot recolour the
/// badge. iOS 26 puts bar buttons on light glass, where dark icons read; earlier versions draw them
/// straight on the navy bar, where light ones do.
enum BellImage {
    static func make(count: Int) -> UIImage {
        let ink: UIColor
        if #available(iOS 26.0, *) { ink = Brand.navy } else { ink = Brand.cream }
        let size = CGSize(width: 30, height: 30)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { _ in
            let symbol = UIImage(systemName: "bell", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .regular))?
                .withTintColor(ink, renderingMode: .alwaysOriginal)
            symbol?.draw(in: CGRect(x: (size.width - 22) / 2, y: (size.height - 22) / 2 + 1, width: 22, height: 22))

            guard count > 0 else { return }
            let text = count > 9 ? "9+" : "\(count)"
            let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 10, weight: .bold), .foregroundColor: UIColor.white]
            let label = NSAttributedString(string: text, attributes: attributes)
            let textSize = label.size()
            let width = max(15, textSize.width + 8)
            let badge = CGRect(x: size.width - width, y: 0, width: width, height: 15)
            Brand.terracotta.setFill()
            UIBezierPath(roundedRect: badge, cornerRadius: 7.5).fill()
            label.draw(at: CGPoint(x: badge.midX - textSize.width / 2, y: badge.midY - textSize.height / 2))
        }
        return image.withRenderingMode(.alwaysOriginal)
    }
}
