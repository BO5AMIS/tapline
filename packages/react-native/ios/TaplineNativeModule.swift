import ExpoModulesCore
import UIKit

/// Tapline's native side (optional: the SDK works without it, through react-native-view-shot).
///
/// - `capture`: a JPEG of the app's window. With `fresh: false` it draws what is on screen now
///   (`afterScreenUpdates: false`), so iOS isn't made to render a new frame for it: the live
///   viewer can capture often without slowing the app.
/// - `cover`: what UIKit presents over the app that React Native doesn't draw: an alert or action
///   sheet (`UIAlertController`, also the one `Alert.alert` shows) and the share sheet
///   (`UIActivityViewController`), with what an agent needs to name it.
private enum TaplineWindows {
  static func keyWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    guard let windows = scene?.windows else { return nil }
    return windows.first { $0.isKeyWindow } ?? windows.first
  }

  /// The view controllers presented over the root, front last.
  static func presented(from root: UIViewController?) -> [UIViewController] {
    var chain: [UIViewController] = []
    var current = root?.presentedViewController
    while let controller = current {
      chain.append(controller)
      current = controller.presentedViewController
    }
    return chain
  }
}

public final class TaplineNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TaplineNative")

    /// Base64 JPEG of the key window at `pixelWidth` pixels wide (the height keeps the window's
    /// shape), or an empty string when there is no window to draw.
    AsyncFunction("capture") { (pixelWidth: Double, quality: Double, fresh: Bool) -> String in
      guard let window = TaplineWindows.keyWindow(), window.bounds.width > 0, pixelWidth > 0 else { return "" }
      let bounds = window.bounds
      let size = CGSize(width: pixelWidth.rounded(), height: (pixelWidth * bounds.height / bounds.width).rounded())
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      format.opaque = true
      let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
        window.drawHierarchy(in: CGRect(origin: .zero, size: size), afterScreenUpdates: fresh)
      }
      let clamped = CGFloat(min(max(quality, 0.1), 1))
      return image.jpegData(compressionQuality: clamped)?.base64EncodedString() ?? ""
    }.runOnQueue(.main)

    /// What UIKit shows in front of the app: `kind` is "alert", "actionSheet", "share" or "" (nothing).
    AsyncFunction("cover") { () -> [String: Any] in
      let chain = TaplineWindows.presented(from: TaplineWindows.keyWindow()?.rootViewController)
      for controller in chain.reversed() {
        if let alert = controller as? UIAlertController {
          return [
            "kind": alert.preferredStyle == .actionSheet ? "actionSheet" : "alert",
            "title": alert.title ?? "",
            "message": alert.message ?? "",
            "buttons": alert.actions.map { $0.title ?? "" },
            "destructive": alert.actions.map { $0.style == .destructive },
          ]
        }
        if controller is UIActivityViewController {
          return ["kind": "share", "title": "", "message": "", "buttons": [String](), "destructive": [Bool]()]
        }
      }
      return ["kind": "", "title": "", "message": "", "buttons": [String](), "destructive": [Bool]()]
    }.runOnQueue(.main)
  }
}
