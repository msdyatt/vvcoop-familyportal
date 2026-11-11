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
        configuration.appearance.colors.primary = Brand.navy

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

    /// A bank's own page sends the person back through `org.veritasvillage.family://stripe-redirect`.
    func handle(url: URL) -> Bool { StripeAPI.handleURLCallback(with: url) }
}
