import AuthenticationServices
import Capacitor
import CryptoKit
import Foundation
import UIKit

/*
  Signing in with Apple from inside the app, using Apple's own sheet.

  The web side can already do this without any native code at all — it navigates
  out to appleid.apple.com and back, and that works in a WKWebView. This exists
  because it is a markedly worse thing to do on a phone. The redirect leaves the
  app, shows a web page asking for an Apple ID and a password, and comes back;
  ASAuthorizationController shows the system sheet, which already knows who is
  signed in on the device and authenticates them with Face ID. The learner types
  nothing. It is also the flow Apple's own review guidance describes for an app
  that offers Sign in with Apple at all.

  ---------------------------------------------------------------------------
  Why the button is still HTML

  Apple ships ASAuthorizationAppleIDButton, which draws the button to spec so
  nobody has to. It is not used here, and the reason is structural rather than a
  preference: this app's sign-in screen is a web page, so a native button would
  have to be positioned over the web view, tracked as the page scrolls, and torn
  down when the route changes — which is the machinery NativeChromePlugin exists
  for, and a great deal of it for one control. What is drawn instead is
  components/account/AppleSignIn.tsx, following Apple's published design for a
  custom button; that path is explicitly permitted and is what every web
  implementation uses. The trade is that the button's measurements are BandUp's
  responsibility, which is said out loud in a comment there.

  ---------------------------------------------------------------------------
  The nonce, and who hashes it

  This generates a random value, sends Apple its SHA-256 digest, and hands the
  *original* to the web layer to forward to the server. Apple echoes the digest
  back inside the signed identity token, and the server hashes the original
  again and compares. So the raw nonce travels only from this phone to BandUp,
  Apple never sees it, and a token captured in flight cannot be replayed against
  a sign-in it was not minted for. It is the same division of labour Google
  Identity Services performs on the web, done here because on iOS there is no
  script to do it.

  ---------------------------------------------------------------------------
  The name, which arrives exactly once

  `fullName` is populated on the first authorization of this app by this Apple
  ID and is nil every time afterwards — not on the next launch, not after a
  reinstall, and not on request. There is no way to ask for it again short of
  the learner revoking the app entirely in Settings. So it is read here and
  passed on immediately; the server writes it onto a profile that has no name
  yet and never overwrites one that has. If this request drops it, it is gone.

  Registered from MainViewController.capacitorDidLoad alongside the other three
  app-target plugins, for the reason given at the top of that file: these ship
  as source rather than as npm packages, so nothing teaches Capacitor's ordinary
  auto-registration that they exist.
*/
@objc(SignInWithApplePlugin)
public class SignInWithApplePlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "SignInWithApplePlugin"
  public let jsName = "SignInWithApple"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
  ]

  /*
    The call and the controller are both held for the length of one
    authorization. The call because its resolution happens in a delegate
    callback rather than in the method that received it, and the controller
    because nothing else has a strong reference to it once performRequests
    returns — an ASAuthorizationController that is deallocated mid-flight simply
    never calls back, which presents as a sheet that appears and then nothing.
  */
  private var pendingCall: CAPPluginCall?
  private var pendingController: ASAuthorizationController?
  private var pendingNonce: String?

  @objc func authorize(_ call: CAPPluginCall) {
    /*
      One at a time. A second tap while the sheet is up would otherwise replace
      the pending call and leave the first one unresolved forever, which on the
      JavaScript side is a promise that never settles and a button stuck in its
      busy state.
    */
    if pendingCall != nil {
      call.reject("An Apple sign-in is already in progress")
      return
    }

    guard let nonce = Self.randomNonce() else {
      call.reject("Apple sign-in could not be started")
      return
    }

    let request = ASAuthorizationAppleIDProvider().createRequest()
    /*
      Both scopes asked for, and both may be declined. A learner can choose to
      hide their email, in which case Apple mints a per-app forwarding address
      at privaterelay.appleid.com and sends that instead; they can also decline
      the name, in which case fullName is nil here on the first authorization
      just as it is on every later one. Neither is an error and neither stops
      the sign-in — the account is keyed on Apple's stable subject, not on
      anything in this request.
    */
    request.requestedScopes = [.fullName, .email]
    request.nonce = Self.sha256Hex(nonce)

    let controller = ASAuthorizationController(authorizationRequests: [request])
    controller.delegate = self
    controller.presentationContextProvider = self

    pendingCall = call
    pendingController = controller
    pendingNonce = nonce

    DispatchQueue.main.async {
      controller.performRequests()
    }
  }

  private func finish(rejecting message: String) {
    let call = pendingCall
    clearPending()
    call?.reject(message)
  }

  private func clearPending() {
    pendingCall = nil
    pendingController = nil
    pendingNonce = nil
  }

  /// 32 bytes of system randomness, base64url so it survives a JSON round trip.
  private static func randomNonce() -> String? {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      return nil
    }
    return Data(bytes)
      .base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /*
    Lower-case hex, because that is the spelling the server compares against —
    lib/auth/apple-token.ts builds the same digest from the raw nonce with
    crypto.subtle and formats each byte with padStart(2, "0"). Two encodings of
    the same hash do not compare equal, and the symptom would be every native
    sign-in failing verification with nothing else wrong.
  */
  private static func sha256Hex(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8))
      .map { String(format: "%02x", $0) }
      .joined()
  }
}

extension SignInWithApplePlugin: ASAuthorizationControllerDelegate {
  public func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    guard let call = pendingCall, let nonce = pendingNonce else { return }

    guard
      let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
      let tokenData = credential.identityToken,
      let identityToken = String(data: tokenData, encoding: .utf8),
      !identityToken.isEmpty
    else {
      finish(rejecting: "Apple did not return an identity token")
      return
    }

    /*
      Only the token, the nonce and the name are handed over. The credential
      also carries `user` — Apple's subject — and an authorization code, and
      neither is passed on: the subject is inside the signed token where it
      cannot be tampered with, and a code this app has no client secret to
      exchange would be a value sent for no reason. What the server trusts is
      the signature, and nothing beside it.
    */
    clearPending()
    call.resolve([
      "identityToken": identityToken,
      "nonce": nonce,
      "givenName": credential.fullName?.givenName ?? NSNull(),
      "familyName": credential.fullName?.familyName ?? NSNull()
    ])
  }

  public func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithError error: Error
  ) {
    /*
      A cancellation is by far the most common way to arrive here — it is what
      dismissing the sheet does — so it is named rather than reported as a
      failure. The web side shows nothing for it beyond returning the button to
      its resting state, which is the right response to somebody who changed
      their mind.
    */
    if let authorizationError = error as? ASAuthorizationError,
       authorizationError.code == .canceled {
      finish(rejecting: "cancelled")
      return
    }
    finish(rejecting: "Apple sign-in could not be completed")
  }
}

extension SignInWithApplePlugin: ASAuthorizationControllerPresentationContextProviding {
  public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    /*
      The window the app is actually in. `bridge?.viewController?.view.window` is
      the accurate answer and it can be nil during a rotation or a scene
      transition, so there is a fallback to the first connected foreground
      window — returning a fresh empty ASPresentationAnchor() instead would show
      the sheet over nothing.
    */
    if let window = bridge?.viewController?.view.window {
      return window
    }
    let scene = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive }
    return scene?.windows.first { $0.isKeyWindow }
      ?? scene?.windows.first
      ?? ASPresentationAnchor()
  }
}
