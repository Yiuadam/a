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
https://bandup.life
```

## Step 2 — Build the iOS project

```bash
npm install
NEXT_PUBLIC_API_BASE=https://bandup.life npm run build:mobile
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
   <key>NSCameraUsageDescription</key>
   <string>BandUp takes a photo when you choose the camera for your profile picture, so it can show it on your account.</string>
   <key>NSMicrophoneUsageDescription</key>
   <string>BandUp records your answers during a practice speaking test so it can score them.</string>
   <key>NSSpeechRecognitionUsageDescription</key>
   <string>BandUp converts your spoken answers to text so an examiner model can grade your speaking.</string>
   ```

   The camera one is easy to leave out, because nothing in the app is called a
   camera feature. The profile picture is an ordinary file input, and iOS
   answers one that accepts images with a sheet offering *Take Photo or Video*
   beside the photo library — so a learner is one tap from the camera on a
   screen nobody thinks of that way. Without the string that tap is the
   termination described above rather than a refusal: they lose the app, not
   just the photo.
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
4. **Privacy questionnaire** — the step most likely to be answered wrongly,
   because the honest answer is much longer than the one feature everybody
   thinks of. Answer it from `app/privacy/page.tsx`, which is the promise the
   app makes to the learner inside the app itself, and not from memory. A label
   that claims less than that page does is not a technicality; it is a
   misrepresentation, and an account-gated app that declares no contact
   information is the mismatch Apple's privacy review catches most reliably.

   Audio is the part that is genuinely reassuring, and the wording matters. It
   is collected *transiently*: in the app the recording is handed to Apple's
   own speech recogniser, which decides for itself whether to transcribe on the
   phone or on Apple's servers, and only the resulting text reaches BandUp for
   grading. No audio file is uploaded and none is stored. Do **not** claim
   on-device-only transcription here — the Whisper option is a web feature, and
   `ios-plugins/local-transcription` is not in `ios/App/CapApp-SPM/Package.swift`,
   so it is not in the build at all.

   Everything else follows from the app having accounts, and it does. Declare
   **Contact Info** for the email address and the display name; **Identifiers**
   for the account ID the record is filed under and for the username, which
   doubles as a sign-in name and is shown in an organisation's directory;
   **User Content** for the essays and speaking transcripts kept with saved
   practice, for synced practice generally, and for the profile photo, which is
   stored as a private file in Cloudflare R2; and **Other Data** for the
   optional date of birth, which exists to check the learner is 13 or over and
   is read for nothing else. Every one of those is linked to the user's
   identity and every one is used for App Functionality. There is no
   advertising or analytics SDK in `package.json`, so **Data Used to Track
   You** is empty and no purpose other than App Functionality should be ticked.

   Two smaller ones are a judgement call rather than an oversight, so settle
   them deliberately instead of passing over them. A thirty-day count of AI
   requests is kept so each feature's allowance can be applied — it records
   that a request happened and to which feature, never what was written or
   said — which is Usage Data, product interaction, linked to identity. And a
   salted one-way hash of the requesting address is kept so that one address
   cannot spend unlimited AI by making accounts; it cannot be turned back into
   an address and is used for nothing else. Where either is declared, App
   Functionality is again the purpose.
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

**Guideline 4.8 — Login Services.** The iOS build offers no third-party login
at all, and that is a decision rather than an omission. 4.8 says an app that
offers one must also offer an equivalent option that limits data collection to
name and email, lets the learner keep that address private, and does not
collect interactions for advertising. BandUp's own sign-up cannot be that
option, because it needs a real, confirmable address and the sign-in-link form
is recovery only. Sign in with Apple could have been, but it ships dormant —
the four `APPLE_SIGNIN_*` secrets are unset and `App.entitlements` is
deliberately not referenced from `project.pbxproj` — so no Apple button is ever
drawn. Google was therefore removed from the app instead, in
`components/account/SignedOut.tsx`, which puts BandUp inside 4.8's own
exception for an app using exclusively the developer's account system. Nothing
was lost: the button could not work in the app anyway, because Capacitor hands
a top-level navigation off the app's own origin to Safari and no session ever
came back from it.

Putting either provider back into the app is real work rather than a flag.
Apple needs paid Developer Program membership, the capability ticked on the App
ID, `CODE_SIGN_ENTITLEMENTS` pointed at `ios/App/App/App.entitlements` and the
four secrets set on the Worker — after which `/api/account/status` starts
offering it with no code change at all. Google needs an in-app flow that does
not exist yet: `ASWebAuthenticationSession`, a callback scheme registered in
`Info.plist`, and a bridge handing the returned session to the WebView. Adding
`accounts.google.com` to `server.allowNavigation` is not a substitute, because
Google refuses OAuth inside an embedded WebView.

**Trademark.** "IELTS" is a registered trademark of the British Council, IDP and
Cambridge English. Do not put it in the app *name*. Using it descriptively
("practice for the IELTS exam") in the description is normal, and the
disclaimer already in the app footer should stay.

## Updating the app later

```bash
NEXT_PUBLIC_API_BASE=https://bandup.life npm run build:mobile
npx cap sync ios
```
then archive and upload a build with a higher version number. Changes to the
API alone need no resubmission — only bundled UI changes do.
