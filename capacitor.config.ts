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
    contentInset: "always",
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
