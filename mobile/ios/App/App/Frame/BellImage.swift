import UIKit

/// The notification bell with an unread count in a small badge, drawn into one image so the badge keeps its
/// colour whatever the button around it does.
enum BellImage {
    static func make(count: Int, ink: UIColor) -> UIImage {
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
