import AVFoundation
import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        /*
          The listening test has to be audible with the ringer switch off.

          A WKWebView plays into the `ambient` audio session by default, and
          `ambient` is silenced by the hardware mute switch — so a candidate
          whose phone is on silent, which on a phone kept in a pocket is most of
          them, would start a listening paper and hear nothing at all. In the
          real exam the audio plays once and does not come back; here the paper
          would be lost to a switch on the side of the device, with no error and
          nothing on screen to explain it.

          `playback` is the category for audio that is the point of the app
          rather than a decoration on it, and it ignores the mute switch. It is
          set once at launch rather than per recording, because by the time a
          recording is playing it is already too late to have decided.

          Deliberately not `.mixWithOthers`: a listening test playing over
          somebody's music is a listening test they will fail. Interrupting the
          music is the correct rudeness.

          SpeechRecognitionPlugin sets its own category while the microphone is
          open and deactivates the session afterwards, which returns the app to
          this one. The two do not fight; recording simply takes precedence for
          as long as it is recording.
        */
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)

        return true
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
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
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
