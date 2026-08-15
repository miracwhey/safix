import Foundation
import Capacitor
import UIKit

/// Capacitor plugin: native iOS Liquid Glass surfaces.
///
/// Renders a real `UIVisualEffectView` *behind* the Capacitor webview, so the
/// glass shows through wherever the web page is transparent. On iOS 26 it uses
/// `UIGlassEffect` (true Liquid Glass); on iOS 16–25 it falls back to a
/// `UIBlurEffect` system material. The web layer positions a transparent CSS
/// placeholder and feeds its `getBoundingClientRect()` here as `rect`.
///
/// One-time host-app setup: the Capacitor webview must be made non-opaque so
/// the glass behind it is visible — see `README.md` ("Integration").
@objc(LiquidGlassPlugin)
public class LiquidGlassPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiquidGlassPlugin"
    public let jsName = "LiquidGlass"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeAll", returnType: CAPPluginReturnPromise),
    ]

    private let manager = GlassViewManager()

    @objc func isAvailable(_ call: CAPPluginCall) {
        var liquidGlass = false
        if #available(iOS 26.0, *) { liquidGlass = true }
        call.resolve(["available": true, "liquidGlass": liquidGlass])
    }

    @objc func present(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("MISSING_ID", "present() requires a non-empty `id`.")
            return
        }
        guard let rectObj = call.getObject("rect"),
              let frame = Self.cgRect(from: rectObj) else {
            call.reject("INVALID_RECT", "present() requires `rect` with numeric x, y, width, height.")
            return
        }
        let style = call.getString("style") ?? "regular"
        let cornerRadius = CGFloat(call.getDouble("cornerRadius") ?? 0)
        let tintHex = call.getString("tintColor")
        let interactive = call.getBool("interactive") ?? false

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let webView = self.bridge?.webView, let host = webView.superview else {
                call.reject("NO_WEBVIEW", "Capacitor webview is not in the view hierarchy.")
                return
            }
            self.manager.present(id: id, frame: frame, style: style,
                                 cornerRadius: cornerRadius, tintHex: tintHex,
                                 interactive: interactive, host: host, below: webView)
            call.resolve()
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("MISSING_ID", "update() requires a non-empty `id`.")
            return
        }
        let frame = call.getObject("rect").flatMap { Self.cgRect(from: $0) }
        let cornerRadius = call.getDouble("cornerRadius").map { CGFloat($0) }

        DispatchQueue.main.async { [weak self] in
            self?.manager.update(id: id, frame: frame, cornerRadius: cornerRadius)
            call.resolve()
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("MISSING_ID", "remove() requires a non-empty `id`.")
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.manager.remove(id: id)
            call.resolve()
        }
    }

    @objc func removeAll(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.manager.removeAll()
            call.resolve()
        }
    }

    /// Parse a JS `{ x, y, width, height }` object into a `CGRect` (points).
    /// JSON numbers bridge to `NSNumber`, so accept that uniformly.
    private static func cgRect(from obj: JSObject) -> CGRect? {
        guard let x = (obj["x"] as? NSNumber)?.doubleValue,
              let y = (obj["y"] as? NSNumber)?.doubleValue,
              let w = (obj["width"] as? NSNumber)?.doubleValue,
              let h = (obj["height"] as? NSNumber)?.doubleValue else {
            return nil
        }
        return CGRect(x: x, y: y, width: w, height: h)
    }
}
