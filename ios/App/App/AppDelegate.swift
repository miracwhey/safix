import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        registerNotificationCategories()
        return true
    }

    // APNs-Token-Weiterreichung an @capacitor/push-notifications. Capacitor-Core
    // swizzelt diese beiden UIApplicationDelegate-Methoden NICHT (nur Keyboard/
    // StatusBar). Ohne diese Posts feuert der `registration`-Listener der JS-Bridge
    // nie → `notification_device_tokens` bleibt leer → keine Pushes. Das Plugin
    // lauscht auf genau diese Notification-Namen und liest `object` als Data/Error
    // (PushNotificationsPlugin.swift:184/202).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    /// Registriert iOS Notification-Categories für Inline-Actions auf dem Lockscreen.
    /// MUSS in sync mit `src/lib/notifications/pushActionRegistry.ts` bleiben — der TS-Spiegel
    /// hat einen Schema-Lock-Test der bei Drift bricht.
    /// Push-Payload muss `aps.category: "CORRECTION_DECISION"` setzen, damit iOS die Buttons
    /// im Banner-Pull / Long-Press anzeigt.
    private func registerNotificationCategories() {
        let approve = UNNotificationAction(
            identifier: "APPROVE",
            title: "Annehmen",
            options: [.foreground, .authenticationRequired]
        )
        let reject = UNNotificationAction(
            identifier: "REJECT",
            title: "Ablehnen",
            options: [.foreground, .authenticationRequired, .destructive]
        )
        let correctionDecision = UNNotificationCategory(
            identifier: "CORRECTION_DECISION",
            actions: [approve, reject],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([correctionDecision])
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Capacitor sets scrollView.bounces = false in CAPBridgeViewController (line 301).
        // Re-enable so surfaces whose body genuinely overflows keep the natural
        // rubber-band. `alwaysBounceVertical` stays OFF (Block 3 scroll-twofer):
        // AppShell screens scroll in an inner CSS container and the body content
        // is exactly viewport-high there — a force-bouncing WKScrollView made the
        // whole app rubber-band on top of the inner message scroll.
        if let rootVC = window?.rootViewController as? CAPBridgeViewController,
           let scrollView = rootVC.webView?.scrollView {
            scrollView.bounces = true
        }
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
