# Shipping BandUp to the App Store

The repo is set up to build an iOS app from the same code as the website. What
follows is everything between here and a live App Store listing, in order.

## What you need that this repo cannot provide

| Requirement | Why | Cost |
|---|---|---|
| A Mac with Xcode | Apple only allows iOS apps to be built and signed on macOS | — |
| Apple Developer Program membership | Required to submit anything to the store | $99/year |
| A deployed API (Cloudflare Workers) | The app calls your `/api` routes for AI marking | free tier is fine |
| A public privacy-policy URL | Apple rejects submissions without one, and this app uses the microphone | free (a page on your site) |

If you don't have a Mac, a cloud macOS build service (Codemagic, Bitrise,
MacStadium) can do the build and upload step instead.

## Step 1 — Deploy the web API first

The iOS bundle has no server inside it, so it must call your deployed API.

Merging to `main` deploys it. The Worker needs `ANTHROPIC_API_KEY` set on it —
Cloudflare dashboard → **Workers & Pages** → **bandup** → **Settings** →
**Variables and Secrets** — or the AI marking routes will answer with an error.

The production URL is fixed and everything below depends on it:

```
https://bandup.siksafe-realtime-ai-vision.workers.dev
```

## Step 2 — Build the iOS project

```bash
npm install
NEXT_PUBLIC_API_BASE=https://bandup.siksafe-realtime-ai-vision.workers.dev npm run build:mobile
npx cap add ios          # first time only
npx cap sync ios
npx cap open ios         # opens Xcode
```

`build:mobile` produces a static export in `out-mobile/`, temporarily moving the
server routes aside (they can't exist in a static build) and restoring them
afterwards. `cap sync` copies that bundle into the iOS project.

## Step 3 — Configure the app in Xcode

1. **Signing** — select your team under *Signing & Capabilities*. Bundle ID is
   `com.yiuadam.bandup` (change it in `capacitor.config.ts` if you prefer, then
   re-run `cap sync`). **Do not put IELTS in the bundle id.** It reads as a claim
   of affiliation, and unlike the app name or the description it cannot be
   changed after the first submission — Apple fixes a bundle id permanently.
2. **Permission strings** — add these to `ios/App/App/Info.plist`. iOS crashes
   the app on launch of the feature if they're missing, and App Review checks
   the wording:
   ```xml
   <key>NSMicrophoneUsageDescription</key>
   <string>BandUp records your answers during a practice speaking test so it can score them.</string>
   <key>NSSpeechRecognitionUsageDescription</key>
   <string>BandUp converts your spoken answers to text so an examiner model can grade your speaking.</string>
   ```
3. **App icon** — drop a 1024×1024 PNG into `Assets.xcassets/AppIcon`.
   No transparency, no rounded corners; Apple rejects both.

## Step 4 — Test on a real device before submitting

The simulator has no microphone worth testing with. On a physical iPhone, walk
these five paths:

1. **Speaking test, full run.** This is the highest-risk area: iOS uses Apple's
   own speech recogniser through a Capacitor plugin, not the browser API, and
   that path has not been exercised on hardware yet. Watch specifically for
   long answers (60+ seconds) — confirm nothing already spoken gets dropped
   when the recogniser segments an utterance.
2. **Listening test.** Confirm the recording plays turn by turn and stops when
   you leave the page.
3. **Writing.** Submit an essay and confirm marking comes back (this proves the
   app is reaching your deployed API).
4. **Airplane mode.** Placement, plan and bundled tests must still work; the AI
   features should show a readable error rather than hanging.
5. **Interruptions.** Take a phone call mid-recording, then return to the app.

## Step 5 — Submit

1. In App Store Connect, create the app record (name, subtitle, category
   *Education*).
2. Xcode → *Product → Archive* → *Distribute App* → App Store Connect.
3. Fill in the listing: description, keywords, support URL, privacy policy URL.
4. **Privacy questionnaire** — declare that you collect audio *transiently* for
   the speaking feature. Be accurate: speech is transcribed on-device and only
   the resulting text is sent for grading; nothing is stored on a server.
5. Submit for review. First review typically takes 24–48 hours.

## The rejection risks worth pre-empting

**Guideline 4.2 — Minimum Functionality.** Apple rejects apps that are just a
website in a shell. This app has a real defence: content ships inside the
bundle and works offline, and it uses native microphone and speech-recognition
APIs. Strengthen it further before submitting by making sure the app never
shows a bare browser-like page, and mention the offline practice tests in your
review notes.

**Guideline 5.1.1 — Purpose strings.** The two `Info.plist` strings above must
explain the benefit to the user, not just state the fact of access.

**Guideline 2.1 — Completeness.** Reviewers will tap the speaking test. If the
microphone path fails on their device, it's an instant rejection — which is why
step 4.1 above matters more than anything else in this document.

**Trademark.** "IELTS" is a registered trademark of the British Council, IDP and
Cambridge English. Do not put it in the app *name*. Using it descriptively
("practice for the IELTS exam") in the description is normal, and the
disclaimer already in the app footer should stay.

## Updating the app later

```bash
NEXT_PUBLIC_API_BASE=https://bandup.siksafe-realtime-ai-vision.workers.dev npm run build:mobile
npx cap sync ios
```
then archive and upload a build with a higher version number. Changes to the
API alone need no resubmission — only bundled UI changes do.
