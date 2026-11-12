import StripePaymentSheet
import UIKit

/// Stripe's native payment sheet (Apple Pay, bank, card) for dues.
///
/// The page asks through the bridge (`VVNative.call("pay.sheet", ...)`) with what the `dues-checkout` edge
/// function returned for a native payment: the publishable key and the PaymentIntent's client secret. The
/// amount is decided by the database and the server, never by the page. Card and bank details are typed
/// into Stripe's sheet and never reach the web view. Replaces the Capacitor Stripe plugin that Android
/// still uses (see `hasNativePayments` in lib/dues-api.ts).
final class PaymentSheetPresenter {
    static let shared = PaymentSheetPresenter()

    /// Keeps the sheet alive while it is on screen.
    private var sheet: PaymentSheet?

    /// Answers with "completed", "canceled" or "failed".
    func present(options: [String: Any], from presenter: UIViewController, done: @escaping (String) -> Void) {
        guard let publishableKey = options["publishableKey"] as? String,
              let secret = options["paymentIntentClientSecret"] as? String else {
            done("failed")
            return
        }
        STPAPIClient.shared.publishableKey = publishableKey

        var configuration = PaymentSheet.Configuration()
        configuration.merchantDisplayName = options["merchantDisplayName"] as? String ?? "Veritas Village"
        configuration.allowsDelayedPaymentMethods = true
        configuration.returnURL = options["returnURL"] as? String
        if let merchantId = options["applePayMerchantId"] as? String {
            configuration.applePay = .init(merchantId: merchantId, merchantCountryCode: options["countryCode"] as? String ?? "US")
        }
        configuration.appearance = Self.appearance()

        let sheet = PaymentSheet(paymentIntentClientSecret: secret, configuration: configuration)
        self.sheet = sheet
        sheet.present(from: presenter) { [weak self] result in
            self?.sheet = nil
            switch result {
            case .completed: done("completed")
            case .canceled: done("canceled")
            case .failed(let error):
                FrameLog.event("payment sheet failed: \(error.localizedDescription)")
                done("failed")
            }
        }
    }

    /// The sheet in the app's own colours and corners. The colours are the frame's dynamic roles (`Brand`), so the sheet
    /// follows the person's Light / Dark choice like everything else; the web's tokens in app/globals.css are the source.
    private static func appearance() -> PaymentSheet.Appearance {
        var a = PaymentSheet.Appearance()
        let ink = Brand.ink
        a.colors.background = Brand.canvas
        a.colors.componentBackground = Brand.surface
        a.colors.componentBorder = ink.withAlphaComponent(0.18)
        a.colors.componentDivider = ink.withAlphaComponent(0.12)
        a.colors.text = ink
        a.colors.textSecondary = ink.withAlphaComponent(0.65)
        a.colors.componentText = ink
        a.colors.componentPlaceholderText = ink.withAlphaComponent(0.45)
        a.colors.icon = ink.withAlphaComponent(0.7)
        a.colors.primary = Brand.action
        a.colors.danger = Brand.terracotta
        a.cornerRadius = 10
        a.borderWidth = 1
        a.shadow = .disabled
        a.primaryButton.backgroundColor = Brand.action
        a.primaryButton.textColor = Brand.cream
        a.primaryButton.cornerRadius = 10
        // The site sets its headings in a serif; the system serif is the nearest thing without shipping a font.
        if let serif = UIFont.systemFont(ofSize: 17, weight: .semibold).fontDescriptor.withDesign(.serif) {
            a.primaryButton.font = UIFont(descriptor: serif, size: 17)
        }
        return a
    }

    /// A bank's own page sends the person back through `org.veritasvillage.family://stripe-redirect`.
    func handle(url: URL) -> Bool { StripeAPI.handleURLCallback(with: url) }
}
