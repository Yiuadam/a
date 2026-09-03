import AuthenticationServices
import Capacitor
import CryptoKit
import Foundation
import UIKit

/*
  Signing in with Google from inside the app.

  The web side cannot do this on its own, and that is why this exists rather
  than being a convenience. Google Identity Services renders its button by
  running a script from accounts.google.com, and its full-page fallback
  navigates away to Google and back — which in a WKWebView means Capacitor hands
  the navigation to Safari, the learner signs in over there, and the session it
  produces belongs to a browser the app cannot read. That was the state of it
  before: a button that opened Safari and returned nothing. It was removed for
  that reason and this is what putting it back required.

  ---------------------------------------------------------------------------
  What this does instead

  ASWebAuthenticationSession, which is the system's own OAuth sheet. It shares
  Safari's cookie jar, so a learner already signed in to Google on the phone
  sees an account picker rather than a password field, and it hands the redirect
  straight back to the app instead of losing it to another process. The sheet is
  presented by the system and dismissed by it; the app never sees the password,
  which is the point of the design.

  The response type is `id_token`, so what comes back in the redirect fragment
  is a signed assertion of who the learner is — the very thing
  /api/auth/google/token already accepts from the website's button. No token
  exchange, no client secret, and no new server route: an ID token is an ID
  token whichever client minted it, and the server accepts both of this
  project's clients by audience (lib/auth/env.ts, lib/auth/google-token.ts).

  ---------------------------------------------------------------------------
  The nonce, and who hashes it

  The same division of labour SignInWithApplePlugin describes. A random value is
  generated here, its SHA-256 digest goes to Google, and the original is handed
  to the web layer to forward. Google echoes the digest inside the signed token
  and the server hashes the original again to compare, so the raw nonce travels
  only from this phone to BandUp and a token captured in flight cannot be
  replayed against a sign-in it was not minted for.

  ---------------------------------------------------------------------------
  Which client, and why it has no secret

  An iOS OAuth client, registered against this bundle identifier, and a
  different registration from the website's. It has no client secret at all —
  Google does not issue one for an installed application, because a secret
  shipped inside an app is not a secret. Authenticity comes from the redirect
  URI instead: the scheme is the client ID reversed, iOS will only deliver it to
  the app that claims it in Info.plist, and Google will only redirect to a URI
  registered against that client.

  The client ID is not compiled in. It is fetched from /api/auth/google/config
  by the web layer and passed to `authorize`, so a fork or a second deployment
  carries its own without touching this file.

  Registered from MainViewController.capacitorDidLoad alongside the other
  app-target plugins, for the reason given at the top of that file: these ship
  as source rather than as npm packages, so nothing teaches Capacitor's
  auto-registration that they exist.
*/
@objc(GoogleSignInPlugin)
public class GoogleSignInPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "GoogleSignInPlugin"
  public let jsName = "GoogleSignIn"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
  ]

  /*
    Held for the length of one authorization, for the same reason the Apple
    plugin holds its controller: an ASWebAuthenticationSession with no strong
    reference is deallocated the moment `start()` returns, and a deallocated
    session presents a sheet that never calls back.
  */
  private var pendingSession: ASWebAuthenticationSession?

  @objc func authorize(_ call: CAPPluginCall) {
    // One at a time. A second tap would otherwise strand the first promise.
    if pendingSession != nil {
      call.reject("A Google sign-in is already in progress")
      return
    }

    guard let clientId = call.getString("clientId"), !clientId.isEmpty else {
      call.reject("Google sign-in is not configured for this app")
      return
    }
    guard let nonce = Self.randomNonce() else {
      call.reject("Google sign-in could not be started")
      return
    }

    /*
      The reversed client ID, which is the scheme Google requires for an
      installed application and the one Info.plist claims. Built from the value
      that arrived rather than hard-coded, so the two cannot disagree.
    */
    let scheme = clientId.split(separator: ".").reversed().joined(separator: ".")
    let redirect = "\(scheme):/oauth2redirect"

    var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")
    components?.queryItems = [
      URLQueryItem(name: "client_id", value: clientId),
      URLQueryItem(name: "redirect_uri", value: redirect),
      URLQueryItem(name: "response_type", value: "id_token"),
      URLQueryItem(name: "scope", value: "openid email profile"),
      // Google requires the digest here; the raw value goes to BandUp instead.
      URLQueryItem(name: "nonce", value: Self.sha256Hex(nonce)),
      /*
        A picker every time rather than silently reusing whichever account the
        phone last used. On a shared or family device the silent path signs
        somebody into the wrong account with no visible step at which they could
        have noticed.
      */
      URLQueryItem(name: "prompt", value: "select_account"),
    ]
    guard let url = components?.url else {
      call.reject("Google sign-in could not be started")
      return
    }

    let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] callbackURL, error in
      guard let self else { return }
      self.pendingSession = nil

      if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
        /*
          A closed sheet is not a failure. It resolves rather than rejects, with
          a flag the web layer reads, so somebody who changed their mind is not
          shown an error about it.
        */
        call.resolve(["cancelled": true])
        return
      }
      if error != nil {
        call.reject("Google sign-in didn't finish. Please try again.")
        return
      }
      /*
        An implicit response comes back in the fragment, not the query, so the
        parser has to look there. URLComponents will not do it for us: the
        fragment is opaque to it, which is why it is split by hand.
      */
      guard
        let fragment = callbackURL?.fragment,
        let token = Self.value(of: "id_token", in: fragment),
        !token.isEmpty
      else {
        call.reject("Google sign-in could not be completed. Please try again.")
        return
      }
      call.resolve(["credential": token, "nonce": nonce, "cancelled": false])
    }

    session.presentationContextProvider = self
    /*
      Deliberately *not* ephemeral. The whole advantage over the old Safari
      redirect is that this shares the phone's existing Google session, so a
      learner who is already signed in taps their own name and is done.
    */
    session.prefersEphemeralWebBrowserSession = false

    pendingSession = session
    DispatchQueue.main.async {
      if !session.start() {
        self.pendingSession = nil
        call.reject("Google sign-in could not be started")
      }
    }
  }

  /** One parameter out of a `key=value&key=value` fragment, percent-decoded. */
  private static func value(of key: String, in fragment: String) -> String? {
    for pair in fragment.split(separator: "&") {
      let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard parts.count == 2, parts[0] == key else { continue }
      return String(parts[1]).removingPercentEncoding ?? String(parts[1])
    }
    return nil
  }

  private static func randomNonce() -> String? {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      return nil
    }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }

  private static func sha256Hex(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

extension GoogleSignInPlugin: ASWebAuthenticationPresentationContextProviding {
  public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    /*
      The window the web view is in, rather than the first one the app owns.
      They are the same today, and would stop being so the moment anything is
      presented over the app — at which point the sheet would try to attach to a
      window that is no longer on screen.
    */
    bridge?.viewController?.view.window ?? UIApplication.shared.windows.first { $0.isKeyWindow } ?? ASPresentationAnchor()
  }
}
