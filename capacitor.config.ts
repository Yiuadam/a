import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.bandup.ielts",
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
