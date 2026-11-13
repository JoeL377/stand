// Stand for iPhone: a native shell around the live site (capacitor.config.json server.url), like the
// Mac app. What the website can't do on its own lives here:
// - Google sign-in in the system's sign-in sheet (Google refuses web views), handed back to the app
//   through stand://signed-in and swapped for a session (server: /api/auth/app, /api/auth/desktop/redeem).
// - Apple push: once someone is signed in, the app asks to notify them and tells Stand this phone's
//   token (POST /api/push/devices). A tap on a notification opens what it is about.
import UIKit
import Capacitor
import WebKit
import AuthenticationServices
import UserNotifications
import CryptoKit

/// Stand's session cookie (src/server/auth.ts SESSION_COOKIE).
private let sessionCookie = "standup_session"

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Apple can change a phone's token; telling Stand on every return keeps it current.
        StandPush.shared.refresh()
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        StandPush.shared.gotToken(deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[stand] push registration failed: \(error.localizedDescription)")
    }

    // A notification while the app is open still shows: you may be on another page or space.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    // A tap opens what the notification is about (its "url", a path on Stand).
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let path = response.notification.request.content.userInfo["url"] as? String {
            StandViewController.open(path: path)
        }
        completionHandler()
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

// MARK: - The web view

class StandViewController: CAPBridgeViewController, WKHTTPCookieStoreObserver {
    static weak var current: StandViewController?
    /// A notification tapped before the page was ready.
    private static var pendingPath: String?

    /// The live site, from capacitor.config.json.
    var base: URL? { bridge?.config.serverURL }

    override func capacitorDidLoad() {
        StandViewController.current = self
        bridge?.registerPluginInstance(StandSignIn())
        webView?.configuration.websiteDataStore.httpCookieStore.add(self)
        StandPush.shared.refresh()
        if let path = StandViewController.pendingPath {
            StandViewController.pendingPath = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { StandViewController.open(path: path) }
        }
    }

    static func open(path: String) {
        guard let vc = current, let base = vc.base, let url = URL(string: path, relativeTo: base), url.host == base.host else {
            pendingPath = path
            return
        }
        vc.webView?.load(URLRequest(url: url))
    }

    /// The session, when someone is signed in.
    func session(_ done: @escaping (HTTPCookie?) -> Void) {
        guard let store = webView?.configuration.websiteDataStore.httpCookieStore, let host = base?.host else { return done(nil) }
        store.getAllCookies { cookies in
            done(cookies.first { $0.name == sessionCookie && host.hasSuffix($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) })
        }
    }

    // Someone signed in or out (the sheet, the stand-in form, or Sign out).
    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        StandPush.shared.refresh()
    }

    /// Tells the page this phone's token, so Sign out can stop its notifications (src/web/phoneApp.ts).
    func tellPage(token: String) {
        let js = "window.standPhone = { platform: 'ios', pushToken: '\(token)' };"
        webView?.configuration.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView?.evaluateJavaScript(js)
    }
}

// MARK: - Push

final class StandPush {
    static let shared = StandPush()
    private var token: String?
    /// The session and token last sent, so each pair is sent once.
    private var sent: String?

    #if DEBUG
    private let env = "sandbox"
    #else
    private let env = "production"
    #endif

    /// Signed in: ask (once; iOS remembers the answer) and register. Signed out: nothing to do.
    func refresh() {
        DispatchQueue.main.async {
            guard let vc = StandViewController.current else { return }
            vc.session { cookie in
                guard cookie != nil else {
                    self.sent = nil
                    return
                }
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                    guard granted else { return }
                    DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
                }
            }
        }
    }

    func gotToken(_ token: String) {
        self.token = token
        DispatchQueue.main.async {
            guard let vc = StandViewController.current, let base = vc.base else { return }
            vc.tellPage(token: token)
            vc.session { cookie in
                guard let cookie, self.sent != "\(cookie.value):\(token)" else { return }
                var req = URLRequest(url: base.appendingPathComponent("api/push/devices"))
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.setValue("\(sessionCookie)=\(cookie.value)", forHTTPHeaderField: "Cookie")
                req.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token, "env": self.env])
                URLSession.shared.dataTask(with: req) { _, res, _ in
                    if (res as? HTTPURLResponse)?.statusCode == 200 { self.sent = "\(cookie.value):\(token)" }
                }.resume()
            }
        }
    }
}

// MARK: - Sign-in

/// Catches the page's "Sign in with Google" (/api/auth/google) and runs it in the system's sign-in
/// sheet instead, where Google allows it and the person's Safari sign-in carries over.
class StandSignIn: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    let identifier = "StandSignIn"
    let jsName = "StandSignIn"
    let pluginMethods: [CAPPluginMethod] = []
    private var running: ASWebAuthenticationSession?

    override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url, let base = bridge?.config.serverURL,
              url.host == base.host, url.path == "/api/auth/google" else { return nil }
        let next = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "next" }?.value ?? "/"
        DispatchQueue.main.async { self.signIn(base: base, next: next) }
        return true
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    private func signIn(base: URL, next: String) {
        // PKCE: only this app, holding the verifier, can swap the code for a session.
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let verifier = Data(bytes).base64URL
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        var start = URLComponents(url: base.appendingPathComponent("api/auth/app"), resolvingAgainstBaseURL: false)!
        start.queryItems = [URLQueryItem(name: "challenge", value: challenge)]
        let session = ASWebAuthenticationSession(url: start.url!, callbackURLScheme: "stand") { callback, _ in
            self.running = nil
            guard let callback, let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value else { return }
            self.redeem(base: base, code: code, verifier: verifier, next: next)
        }
        session.presentationContextProvider = self
        running = session
        session.start()
    }

    private func redeem(base: URL, code: String, verifier: String, next: String) {
        var req = URLRequest(url: base.appendingPathComponent("api/auth/desktop/redeem"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["code": code, "verifier": verifier])
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let value = body["session"] as? String, let host = base.host else { return }
            let maxAge = (body["maxAgeMs"] as? Double ?? 30 * 24 * 3600 * 1000) / 1000
            let cookie = HTTPCookie(properties: [
                .name: sessionCookie, .value: value, .domain: host, .path: "/",
                .secure: "TRUE", .expires: Date().addingTimeInterval(maxAge),
            ])
            DispatchQueue.main.async {
                guard let cookie, let webView = self.bridge?.webView else { return }
                webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
                    let to = next.hasPrefix("/") && !next.hasPrefix("//") ? next : "/"
                    webView.load(URLRequest(url: URL(string: to, relativeTo: base)!))
                }
            }
        }.resume()
    }
}

private extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
