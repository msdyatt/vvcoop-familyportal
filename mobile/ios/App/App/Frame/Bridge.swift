import UIKit
import WebKit

/// A message from the page to the frame: `VVNative.post(type, payload)`, or
/// `VVNative.call(type, payload)` when the page wants an answer (then `id` is set).
struct BridgeMessage {
    let id: Int?
    let type: String
    let payload: [String: Any]

    init?(_ body: Any) {
        guard let dict = body as? [String: Any], let type = dict["type"] as? String else { return nil }
        self.id = dict["id"] as? Int
        self.type = type
        self.payload = dict["payload"] as? [String: Any] ?? [:]
    }
}

/// The page-facing half of the frame, version 1.
///
/// Injected at document start, before any page script, so the head script that styles the page
/// (lib/platform.ts) can already see it. Nothing here exists in a browser or the home-screen web
/// app, which is what keeps those unchanged.
///
///   page -> frame   VVNative.post(type, payload)                fire and forget
///                   VVNative.call(type, payload) -> Promise     answered by `Bridge.reply`
///   frame -> page   VVNative.on(type, fn)                       events sent by `Bridge.emit`
enum Bridge {
    static let handlerName = "vv"

    static let userScript: WKUserScript = {
        let source = """
        (function () {
          if (window.VVNative) return;
          var pending = {}, listeners = {}, seq = 0;
          function post(message) {
            try { window.webkit.messageHandlers.\(handlerName).postMessage(message); } catch (e) {}
          }
          window.VVNative = {
            frame: true,
            platform: 'ios',
            version: \(FrameConfig.bridgeVersion),
            capabilities: ['share', 'push', 'pay.sheet'],
            post: function (type, payload) { post({ type: type, payload: payload || {} }); },
            call: function (type, payload) {
              return new Promise(function (resolve, reject) {
                var id = ++seq;
                pending[id] = { resolve: resolve, reject: reject };
                post({ id: id, type: type, payload: payload || {} });
              });
            },
            on: function (type, fn) {
              (listeners[type] = listeners[type] || []).push(fn);
              return function () {
                var list = listeners[type] || [];
                var at = list.indexOf(fn);
                if (at >= 0) list.splice(at, 1);
              };
            },
            _reply: function (id, ok, value) {
              var entry = pending[id];
              if (!entry) return;
              delete pending[id];
              if (ok) entry.resolve(value); else entry.reject(new Error(String(value)));
            },
            _emit: function (type, payload) {
              (listeners[type] || []).slice().forEach(function (fn) { try { fn(payload); } catch (e) {} });
            }
          };
          document.documentElement.setAttribute('data-frame', 'ios');
        })();
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }()

    /// Answers a `VVNative.call`.
    static func reply(to message: BridgeMessage, value: Any? = nil, error: String? = nil, in webView: WKWebView) {
        guard let id = message.id else { return }
        let script = error == nil
            ? "VVNative._reply(\(id), true, \(literal(value ?? NSNull())))"
            : "VVNative._reply(\(id), false, \(literal(error ?? "")))"
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    /// Tells the page something happened (`VVNative.on(type, ...)`).
    static func emit(_ type: String, payload: [String: Any] = [:], in webView: WKWebView) {
        webView.evaluateJavaScript("window.VVNative && VVNative._emit(\(literal(type)), \(literal(payload)))", completionHandler: nil)
    }

    /// A value as JavaScript source. JSON is valid JavaScript, so this is also safe to embed.
    static func literal(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject([value]),
              let data = try? JSONSerialization.data(withJSONObject: [value], options: []),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        return String(text.dropFirst().dropLast())
    }
}

/// A script message handler that does not keep its target alive. `WKUserContentController` holds its
/// handlers strongly, which would otherwise keep every page in memory after it was popped.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

enum Haptics {
    static func play(_ style: String) {
        switch style {
        case "light": UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case "heavy": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
        default: UISelectionFeedbackGenerator().selectionChanged()
        }
    }
}
