import Capacitor
import UIKit

/*
  Exists for one reason: these plugins ship as App-target source rather than
  as installed npm packages, so `npx cap sync` never learns their class names
  and capacitor.config.json's packageClassList — the file that drives ordinary
  plugin auto-registration — stays silent about both. NativeChrome has no npm
  package at all; SpeechRecognition's package exists and its JS half is used
  as normal, but its iOS half was never wired into CapApp-SPM/Package.swift —
  see the comment atop SpeechRecognitionPlugin.swift for why. capacitorDidLoad()
  is the hook Capacitor itself calls once the bridge exists and before the web
  view starts loading, which makes registerPluginInstance here the earliest
  and the only place a script's first check of `Capacitor.Plugins.NativeChrome`
  or `Capacitor.Plugins.SpeechRecognition` is guaranteed to already find it.

  Storefront is the third and has no npm package either. It answers which App
  Store the app was bought from, which decides whether it may show a link to
  the website's plan pages at all — see lib/billing/storefront.ts. Registering
  it here matters for the same reason as the others and one of its own: the
  web side asks the moment an account screen draws, and a plugin that is not
  there yet answers "no storefront", which it reads as "no link".

  The same override point is also where the bar's height is kept honest
  across rotation: viewSafeAreaInsetsDidChange is a UIViewController callback
  the plugin has no way to receive on its own, since it owns a view rather
  than a view controller.
*/
final class MainViewController: CAPBridgeViewController {
  private let nativeChrome = NativeChromePlugin()
  private let speechRecognition = SpeechRecognitionPlugin()
  private let storefront = StorefrontPlugin()

  override func capacitorDidLoad() {
    bridge?.registerPluginInstance(nativeChrome)
    bridge?.registerPluginInstance(speechRecognition)
    bridge?.registerPluginInstance(storefront)
  }

  override func viewDidLoad() {
    super.viewDidLoad()

    /*
      No rubber band at the top of a page.

      A web view bounces past its own content by default, which is right for a
      browser — the page is a document in a window, and pulling it away from
      the chrome shows you that you have reached the end of it. It is wrong
      here. The bar above is not chrome around a document, it is the app's own
      top edge, so pulling the page down opens a gap between the two and shows
      the empty view controller behind, which reads as the layout having come
      apart rather than as the end of the content.

      Turned off for both ends rather than only the top. Clamping one edge
      means a scroll view delegate holding contentOffset every frame, and that
      fights the momentum animation it is overriding; the result is a scroll
      that catches rather than an edge that holds. Nothing here wants the
      bottom bounce either — there is no pull-to-refresh to reveal.
    */
    webView?.scrollView.bounces = false
    webView?.scrollView.alwaysBounceVertical = false
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    nativeChrome.updateForSafeAreaChange()
  }
}
