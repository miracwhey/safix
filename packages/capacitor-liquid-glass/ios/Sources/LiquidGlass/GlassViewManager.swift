import UIKit

/// Owns the native glass surfaces, keyed by the JS-supplied `id`. Each surface
/// is a `UIVisualEffectView` inserted directly below the Capacitor webview.
///
/// The stored type is `UIVisualEffectView` (available since iOS 8) on purpose:
/// `UIGlassEffect` is iOS 26-only and can't annotate a stored property, so the
/// iOS-26 effect is created behind an availability guard and merely *assigned*
/// to the view's `effect`.
final class GlassViewManager {
    private var views: [String: UIVisualEffectView] = [:]

    func present(id: String, frame: CGRect, style: String,
                 cornerRadius: CGFloat, tintHex: String?, interactive: Bool,
                 host: UIView, below webView: UIView) {
        // `present` is idempotent — reuse the view already registered for `id`.
        let glass = views[id] ?? UIVisualEffectView()
        glass.frame = frame
        glass.effect = Self.makeEffect(style: style, tintHex: tintHex, interactive: interactive)
        glass.layer.cornerRadius = cornerRadius
        glass.layer.cornerCurve = .continuous
        glass.clipsToBounds = true

        // Fallback tint (iOS < 26): a `UIBlurEffect` can't be tinted, so colour
        // the content view. On iOS 26 the tint lives on `UIGlassEffect` itself.
        if #available(iOS 26.0, *) {
            glass.contentView.backgroundColor = .clear
        } else if let tintHex, let color = UIColor(hex: tintHex) {
            glass.contentView.backgroundColor = color.withAlphaComponent(0.18)
        } else {
            glass.contentView.backgroundColor = .clear
        }

        if glass.superview == nil {
            host.insertSubview(glass, belowSubview: webView)
        }
        views[id] = glass
    }

    func update(id: String, frame: CGRect?, cornerRadius: CGFloat?) {
        guard let glass = views[id] else { return }
        if let frame { glass.frame = frame }
        if let cornerRadius { glass.layer.cornerRadius = cornerRadius }
    }

    func remove(id: String) {
        views[id]?.removeFromSuperview()
        views.removeValue(forKey: id)
    }

    func removeAll() {
        for view in views.values { view.removeFromSuperview() }
        views.removeAll()
    }

    /// iOS 26+: real Liquid Glass via `UIGlassEffect`. Older iOS: system blur.
    private static func makeEffect(style: String, tintHex: String?, interactive: Bool) -> UIVisualEffect {
        if #available(iOS 26.0, *) {
            let glassStyle: UIGlassEffect.Style = (style == "clear") ? .clear : .regular
            let effect = UIGlassEffect(style: glassStyle)
            effect.isInteractive = interactive
            if let tintHex, let color = UIColor(hex: tintHex) {
                effect.tintColor = color
            }
            return effect
        }
        let blurStyle: UIBlurEffect.Style = (style == "clear") ? .systemUltraThinMaterial : .systemMaterial
        return UIBlurEffect(style: blurStyle)
    }
}

extension UIColor {
    /// `#RRGGBB` or `#RRGGBBAA` hex → `UIColor`. Returns nil on malformed input.
    convenience init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6 || s.count == 8, let value = UInt64(s, radix: 16) else { return nil }
        let r, g, b, a: CGFloat
        if s.count == 6 {
            r = CGFloat((value & 0xFF0000) >> 16) / 255
            g = CGFloat((value & 0x00FF00) >> 8) / 255
            b = CGFloat(value & 0x0000FF) / 255
            a = 1
        } else {
            r = CGFloat((value & 0xFF000000) >> 24) / 255
            g = CGFloat((value & 0x00FF0000) >> 16) / 255
            b = CGFloat((value & 0x0000FF00) >> 8) / 255
            a = CGFloat(value & 0x000000FF) / 255
        }
        self.init(red: r, green: g, blue: b, alpha: a)
    }
}
