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
/// - `setAnimationSpeed`: the speed of every window's layer, for fast-forwarded animations (1 is normal).
private enum TaplineWindows {
  static func keyWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    guard let windows = scene?.windows else { return nil }
    return windows.first { $0.isKeyWindow } ?? windows.first
  }

  /// Every window of the app's scenes (the key window and any other the app or UIKit opened).
  static func allWindows() -> [UIWindow] {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
  }

  /// Sets every window's layer speed (1 is normal) from any thread.
  static func setSpeed(_ speed: Float) {
    let apply = {
      for window in allWindows() { window.layer.speed = speed }
    }
    if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
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
    /// Only the drawing holds the main thread; the JPEG is made on a background queue, so the app's
    /// own frames wait for the draw alone.
    AsyncFunction("capture") { (pixelWidth: Double, quality: Double, fresh: Bool, promise: Promise) in
      guard let window = TaplineWindows.keyWindow(), window.bounds.width > 0, pixelWidth > 0 else {
        promise.resolve("")
        return
      }
      let bounds = window.bounds
      let size = CGSize(width: pixelWidth.rounded(), height: (pixelWidth * bounds.height / bounds.width).rounded())
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      format.opaque = true
      let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
        window.drawHierarchy(in: CGRect(origin: .zero, size: size), afterScreenUpdates: fresh)
      }
      let clamped = CGFloat(min(max(quality, 0.1), 1))
      DispatchQueue.global(qos: .userInitiated).async {
        promise.resolve(image.jpegData(compressionQuality: clamped)?.base64EncodedString() ?? "")
      }
    }.runOnQueue(.main)

    /// Sets the speed of the app's windows' layers (PLAN-1.6 F4; the trick EarlGrey and KIF use). 1 is normal; a
    /// larger number makes every UIKit and Core Animation animation in those windows (native-stack pushes, sheets,
    /// alerts) finish that many times sooner. Timers and JavaScript are not touched. The JavaScript side puts 1 back
    /// on `normal`, on a disconnect and when the session ends.
    AsyncFunction("setAnimationSpeed") { (speed: Double) in
      let safe = speed.isFinite ? min(max(speed, 1), 1000) : 1
      TaplineWindows.setSpeed(Float(safe))
    }.runOnQueue(.main)

    // A JavaScript reload (or a new runtime) makes a new module: the windows are never left fast-forwarded.
    OnCreate { TaplineWindows.setSpeed(1) }
    OnDestroy { TaplineWindows.setSpeed(1) }

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
