import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  /*
    No trademark in the bundle identifier.

    "IELTS" belongs to the British Council, IDP and Cambridge English, and a
    bundle id carrying it reads as a claim of affiliation — the one thing
    APPSTORE.md's trademark section says to avoid. It said so about the app
    *name*; the identifier was missed.

    This is the only such mistake that cannot be undone later: Apple fixes a
    bundle id at first submission and it can never be changed for that app.
    Change it now if a different one is wanted; after the first upload it is
    permanent.
  */
  appId: "com.yiuadam.bandup",
  appName: "BandUp",
  // Populated by `npm run build:mobile` (a static Next.js export).
  webDir: "out-mobile",
  ios: {
    /*
      "never", because this app measures its own top edge and something has to
      not measure it twice.

      With "always", WKWebView pushes the page down by the safe-area inset on
      its own. The header also reserves space — a spacer the height the native
      bar reports, and that height is already the inset plus the bar's own row.
      So the notch was paid for twice and every page opened about 59pt of empty
      paper between the bar and its first heading, which is what the owner saw
      and what the website, measured side by side, does not do.

      Leaving it to the page is the right way round rather than merely the
      cheaper one: the bar is drawn over the web view at a height only the
      native side knows, so the web side has to be told that number regardless.
      Having WebKit guess a second, smaller one from the safe area could only
      ever agree with it by coincidence.

      What this hands to CSS is the bottom edge as well, so anything that used
      to sit above the home indicator by WebKit's doing now needs
      env(safe-area-inset-bottom) of its own.
    */
    contentInset: "never",
    // The app ships its own UI; a white flash on launch looks broken.
    backgroundColor: "#fbf7f2",
  },
  plugins: {
    SpeechRecognition: {
      // Ask for permission the first time the user taps the mic, not at launch.
      permissions: ["speech", "microphone"],
    },
  },
};

export default config;
