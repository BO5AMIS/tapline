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

  /// The speed the app's windows should have now (1 is normal); new windows get it too (see `setSpeed`).
  private static var wanted: Float = 1
  private static var visibleObserver: NSObjectProtocol?

  /// Gives one window's layer `speed` without a jump or a freeze (Apple's QA1673 pattern for changing a layer's
  /// timing). Changing `speed` alone moves the layer's local time, which stops repeating animations (an
  /// ActivityIndicator) after a few flips. So the local time now is read first and kept: it becomes the time offset,
  /// counted from now.
  private static func apply(_ speed: Float, to window: UIWindow) {
    let layer = window.layer
    guard layer.speed != speed else { return }
    let now = CACurrentMediaTime()
    let local = layer.convertTime(now, from: nil)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer.speed = speed
    layer.timeOffset = local
    layer.beginTime = now
    CATransaction.commit()
  }

  /// Sets every window's layer speed (1 is normal) from any thread. While the speed is not 1, a window that
  /// becomes visible later (React Native's alert window, a scene's window) gets it too; at 1 the observer goes.
  static func setSpeed(_ speed: Float) {
    let run = {
      wanted = speed
      for window in allWindows() { apply(speed, to: window) }
      if speed != 1 {
        if visibleObserver == nil {
          visibleObserver = NotificationCenter.default.addObserver(forName: UIWindow.didBecomeVisibleNotification, object: nil, queue: .main) { note in
            if let window = note.object as? UIWindow { apply(wanted, to: window) }
          }
        }
      } else if let observer = visibleObserver {
        NotificationCenter.default.removeObserver(observer)
        visibleObserver = nil
      }
    }
    if Thread.isMainThread { run() } else { DispatchQueue.main.async(execute: run) }
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
    /// alerts) finish that many times sooner. Windows that open while the speed is not 1 get it as they appear.
    /// Timers and JavaScript are not touched. The JavaScript side puts 1 back on `normal`, on a disconnect and when
    /// the session ends.
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
