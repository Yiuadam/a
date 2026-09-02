import Capacitor
import Foundation
import StoreKit
import UIKit

/*
  Which App Store storefront this copy of the app was bought from, and a way
  out of the app to the website.

  Both halves exist for one reason: BandUp sells nothing inside the app, and
  whether it may even *link* to where it does sell things depends on the
  country. Guideline 3.1.1 forbade that link everywhere until April 2025, when
  a US court held Apple in contempt over it and Apple rewrote the US rules the
  next day. So the web side asks this plugin where it is and shows a link only
  where one is lawful — see lib/billing/storefront.ts, which owns the list.

  The storefront is the right question to ask, rather than the device's locale
  or region. A phone set to English in Hong Kong still buys from the Hong Kong
  store, and it is the store's rules the app is judged against; locale would
  answer a question nobody asked and would hand a link to exactly the learner
  it must not go to.
*/
@objc(StorefrontPlugin)
public class StorefrontPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "StorefrontPlugin"
  public let jsName = "Storefront"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "getCountry", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise)
  ]

  /*
    Resolves with null rather than rejecting when there is no storefront to
    report — a device that has never signed in to the App Store, or a StoreKit
    that simply does not answer. Null is a real answer here and the web side
    already treats it as one: no storefront means no link, which is the safe
    direction. A rejection would say the same thing far less clearly and would
    have to be caught at every call site to mean it.
  */
  @objc func getCountry(_ call: CAPPluginCall) {
    /* No #available guard: Storefront arrived in iOS 15 and the project's
       deployment target is 15.0, so one would be a check the compiler already
       knows the answer to — and it warns about exactly that. */
    Task {
      let country = await Storefront.current?.countryCode
      call.resolve(["country": country ?? NSNull()])
    }
  }

  /*
    Opens the URL outside the app, in the learner's own browser.

    It has to leave. Loading the website into this app's own web view would
    replace the bundled app with the live site and strand the learner there
    with no way back — and a payment page inside the app's web view is arguably
    the in-app purchase flow the guideline is about, which is the opposite of
    what this is for.

    Only https, and only the site the app already trusts. This method takes a
    URL from JavaScript, and the whole bundle is on disk in the .ipa where
    anyone can edit it; without these two checks it would be a way to make the
    app open anything at all, including a scheme like tel: or a page dressed up
    as a BandUp sign-in.
  */
  @objc func openExternal(_ call: CAPPluginCall) {
    guard let raw = call.getString("url"),
          let url = URL(string: raw),
          url.scheme?.lowercased() == "https",
          let host = url.host?.lowercased(),
          host == StorefrontPlugin.site || host.hasSuffix(".\(StorefrontPlugin.site)")
    else {
      call.reject("Refusing to open a URL that is not an https link to \(StorefrontPlugin.site)")
      return
    }

    DispatchQueue.main.async {
      UIApplication.shared.open(url, options: [:]) { opened in
        if opened {
          call.resolve()
        } else {
          call.reject("The system declined to open \(url.absoluteString)")
        }
      }
    }
  }

  /// Kept in step with WEB_HOME in lib/platform.ts, which is the web side's
  /// name for the same one place a subscription is bought and managed.
  private static let site = "bandup.life"
}
