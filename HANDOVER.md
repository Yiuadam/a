# BandUp handover — 14 August 2026

This is the first file the next agent should read.

- Repository: `https://github.com/Yiuadam/a`
- Working branch: `codex/optimize-avatar-loading`
- Handover URL after the branch is pushed:
  `https://github.com/Yiuadam/a/blob/codex/optimize-avatar-loading/HANDOVER.md`
- Production: `https://bandup.life`
- Preview: `https://organization-preview.bandup.life`

## Production state

The current production website deployment is live and at 100%:

- Cloudflare Worker version: `7cfaf719-41e5-449a-8794-868a928683d4`
- Deployed: `2026-08-14T12:50:29.744Z`
- Release message: `Harden-audio-delivery-and-release-current-BandUp-website`
- Data modes: learner `dual`; organisation `cloudflare`
- Confirmed bindings: production D1, production R2, Workers AI,
  `AUDIO_GENERATION_RATE_LIMITER` (2 requests/60s),
  `MODEL_FETCH_RATE_LIMITER` (12 requests/60s), and static assets
- Production and preview D1 migrations are current through `0014`; neither has
  a pending D1 migration.

The exact pre-release rollback target is:

```bash
npx wrangler rollback ad033c6e-1d40-482a-9362-8a202cf898d1 \
  --config wrangler.jsonc \
  --message "Rollback hardened website release" \
  --yes
```

Do not roll back to versions 190 or 191: they do not contain the production
D1/R2 bindings. The older binding-complete fallback is version 189,
`72c13030-893a-4bcf-88ab-8ec7a99eed75`.

## Release verification

The deployed snapshot passed:

- `npm test`: 764/764
- TypeScript
- ESLint: 0 errors; two generated declaration warnings only
- `git diff --check`
- ordinary Next.js production build
- OpenNext Cloudflare build
- Wrangler production dry run and binding inspection
- delivery/content/placement checks

Live production smoke after deployment:

- `/`, `/organization`, `/practice/listening?id=listening-1`, `/speaking`,
  `/vocabulary`, `/grammar`, and `/history`: HTTP 200
- signed-out `/api/organization`: expected HTTP 401 JSON
- invalid listening-audio catalogue request: expected empty HTTP 404
- valid built-in listening prompt: HTTP 200 `audio/mpeg`, 20,689 bytes
- cached `Range: bytes=0-31` replay: HTTP 206 `audio/mpeg`, 32 bytes

## What shipped in this release

### Listening and speaking audio

- Listening uses a real native `<audio>` path for the finite built-in paper
  catalogue, with playback progress, retry, turn-boundary pauses, and distinct
  British Athena/Helios speakers.
- Speaking examiner prompts use a finite reviewed server-audio catalogue before
  falling back to device speech.
- Aura-1 MP3s are cached in R2 under version/voice/content-hash keys.
- Public audio routes reject arbitrary text and accept only exact catalogue IDs
  plus exact immutable version, voice, and hash tokens.
- Cold-cache AI generation is rate-limited per exact recording key. Large
  Kokoro/Whisper fallback relays are exact allowlists and rate-limited per
  asset/client.
- Whisper model downloads support resumable Range fetching and validate the
  actual little-endian GGML magic. The broken upstream mirror was removed.
- Speaking turn control no longer opens the learner answer before every sentence
  of the examiner prompt completes. Stale callbacks, replay, cancellation,
  preparation timers, recognition races, and repeated “All right, thank you”
  handoffs were addressed.
- The unused Geist Mono global preload was disabled.

Key files:

- `app/api/listening-audio/route.ts`
- `app/api/examiner-audio/route.ts`
- `lib/listening-audio.ts`
- `lib/examiner-audio.ts`
- `app/practice/listening/page.tsx`
- `components/speaking/SpeakingSession.tsx`
- `lib/speech.ts`, `lib/neural-speech.ts`, `lib/transcribe.ts`

### Lookup history, favourites, and pronunciation

- Successful lookups are stored in synced history.
- Favouriting is independent, timestamped state; unpinning cannot delete the
  lookup and wins correctly across devices.
- History has an `Open lookup history` card leading to separate All lookups and
  Pinned words columns.
- Lookup explanations expose visible Listen and Pin word actions. Pronunciation
  uses device speech first and the local British voice fallback when available.
- The selection lookup pill remains statically above the selected word; it no
  longer darts away from the pointer.

Key files:

- `lib/lookups.ts`, `lib/pronunciation.ts`
- `components/Lookup.tsx`, `components/PronunciationButton.tsx`
- `app/history/lookups/page.tsx`

### Organisation workspace

- Students, teachers, managers, and website admins can switch organisations
  when they have more than one eligible active membership.
- The organisation name card, view tabs, settings, and switcher are consistent
  for managers and platform admins.
- Team is now a directory with separate full pages for Invite people, Assign
  students to a teacher, and Review team pairings.
- Team-pairing cards are compact on phones; unassign is an icon-only × with a
  second confirmation.
- Platform administration is a website-admin-only clickable card and dedicated
  page.
- Active managers/owners and platform admins can permanently delete an
  organisation after typing its exact name. The operation is atomic, audited,
  idempotent, and preserves learner-owned practice history.
- The delete card now has a single-line title, icon-only × trigger, and a normal
  full-width consequences paragraph.
- Direct privileged Team URLs are normalised safely for unauthorised roles.

Key files:

- `components/organization/OrganizationPortal.tsx`
- `lib/cloudflare/organization-commands.ts`
- `lib/organizations/action-payloads.ts`

### Practice and layout

- Writing now opens the same paper chooser pattern as Reading and Listening,
  with stable `?id=` deep links.
- Phone writing is one full-width vertical document: Task, Source, Response.
  Tables and charts fit the viewport; the outer cramped glass carousel is gone.
- Vocabulary and Grammar use compact topic indexes, two rows on desktop, compact
  phone grids, a slim More row, and side-by-side lesson/exercise workspaces on
  desktop.
- Plan task scrollers reserve a safe internal overscan gutter so stretched glass
  edges are not clipped.
- Navigation opens immediately without the expensive staggered materialisation
  animation while retaining the fixed blurred glass sheet.
- Pointer attraction moves only the decorative refractive layer. Text, icons,
  hit targets, and focus outlines remain still.
- The owner-console logo uses the full BandUp mark rather than the rear plaque.

### Sync, account, and admin correctness

- Placement results merge by their own valid placement date, independent of
  unrelated profile changes, and refresh subscribed UI stores.
- Google sign-in keeps GIS as primary and shows a full-navigation OAuth fallback
  when scripts/config/initialisation are blocked. Canonical www/HTTP redirects
  point to `https://bandup.life`.
- Cross-origin API preflight now permits the authenticated PUT/PATCH/DELETE verbs
  used by progress clear, profile, and avatar operations.
- Cloudflare migration readiness now explains missing/invalid restricted source
  evidence instead of painting false green statuses.

## Known work left for the next agent

### 1. iOS static export (P1, not a website-production issue)

`npm run build:mobile` still fails because the static iOS export encounters the
dynamic website route:

`app/organization/students/[id]/sittings/[attemptId]`

The parent `app/organization/students/[id]` is dynamic too. Do not merely remove
these pages from mobile: that would silently delete teacher/student-history
functionality. Design a static query-shell route for mobile (or another
deliberate native routing strategy), update links/deep links, preserve old web
URLs, then rerun:

```bash
NEXT_PUBLIC_API_BASE=https://bandup.life \
  npm run build:mobile
```

`scripts/build-mobile.mjs` already excludes the website-only `/admin` tree and
the mobile header no longer links to it.

### 2. Cloudflare-only readiness evidence

The owner readiness screen previously showed all Supabase-backed domains as
`unavailable`. The UI now gives the safe cause/remediation, but do not mark the
domains ready in code. Verify in production Supabase that migration
`0029_cloudflare_migration_readiness.sql` is applied, its RPC is executable by
service role, and PostgREST reloaded its schema. Also verify `0030` source clocks
and apply `0031` before relying on the Supabase organisation-switch fallback.

Cloudflare-only cutover remains intentionally **not ready**. Production learner
mode must stay `dual` until the readiness report is exact and its unsupported
runtime paths are resolved.

### 3. Ben plan discrepancy

Do not change the admin label based on memory. Both Ben accounts currently
resolve as Free from the authoritative entitlement ledger, while the overview
reported two active Stripe objects and D1 had no subscription rows. Reconcile
Stripe subscription metadata/webhooks against the exact account UUID and
Supabase `subscriptions` row. There are two Ben accounts, so name matching is
unsafe.

### 4. GitHub/CI release path

The manual production deploy is versioned and rollbackable, but the GitHub
production workflow builds merged `main`. Merge this branch only after reviewing
the draft PR and the known iOS P1. Once merged, future deployments should name
the exact commit SHA in their release message.

## Liquid-glass research and localhost-only plan

The user asked for a plan first and explicitly said the experiment must stay on
localhost. No new glass experiment was deployed to preview or production.

The research conclusion: use no ML model. Live refraction must transform the
current pixels behind the DOM every frame; image-generation LoRAs only create
still images. BandUp already has the correct lightweight foundation:
`liquid-glass-react`, an aria-hidden refractive layer, one delegated ~30 fps
pointer loop, pixel-area caps, and accessibility/low-tier fallbacks.

Useful Hugging Face references:

- Apple FastVLM glass components (reference only; no declared repository
  licence):
  `https://huggingface.co/spaces/apple/fastvlm-webgpu/blob/main/src/components/GlassContainer.tsx`
  and
  `https://huggingface.co/spaces/apple/fastvlm-webgpu/blob/main/src/components/GlassFilters.tsx`
- TencentARC ToonComposer MIT SVG specular/displacement pipeline:
  `https://huggingface.co/spaces/TencentARC/ToonComposer/blob/main/util/stylesheets.py`
- LiquidAI MIT WebGL fluid renderer (too heavy for nav/mobile, reference only):
  `https://huggingface.co/spaces/LiquidAI/LFM2-VL-WebGPU/blob/main/src/components/FluidBackdrop.tsx`
- LIQGLASS is a static FLUX LoRA, not a live UI engine; do not add it.

Recommended localhost prototype:

1. Add `optics?: "standard" | "enhanced"` to `RefractiveGlassLayer`, defaulting
   to current behaviour.
2. Gate the experiment behind an ignored local variable such as
   `NEXT_PUBLIC_GLASS_LAB=1`; absence must preserve production rendering.
3. Keep `mode="standard"`, the frozen package pointer, `elasticity={0}`, and the
   existing delegated pointer variables. Do not enable the package shader mode:
   it builds a per-pixel displacement bitmap on mount/resize.
4. For `enhanced`, add a narrow Fresnel/specular rim driven by
   `--glass-reflection-x/y`, a darker opposite edge, slightly lower tint opacity,
   and only subtle internal warp scale (`1.012–1.018`). Move no semantic content.
5. Apply it to a few small surfaces only: organisation view controls and one
   homepage CTA/card. Do not apply it to prose, popovers, exam surfaces, or the
   full-viewport nav.
6. Remove/avoid the full-screen SVG refractive layer in the nav lab. The existing
   42px CSS backdrop blur and tint provide the material at much lower cost.
7. Preserve current fallbacks for Safari/Firefox, phones/coarse pointers,
   reduced motion/transparency, Save-Data, ≤4 GB/≤4-core devices, hidden tabs,
   and surfaces over the 1.25M-device-pixel cap.
8. Validate localhost only in Light/Warm/Dark at 320, 390, and desktop; measure
   nav opening and pointer sweeps; ensure text, focus, and boundaries do not move
   or clip. Do not deploy until the user explicitly approves the visual result.

## Copy/paste continuation prompt

```text
Read HANDOVER.md, AGENTS.md, DEPLOY.md, ORGANIZATIONS.md and TRANSCRIPTION.md
before editing. Production is Cloudflare Worker version
7cfaf719-41e5-449a-8794-868a928683d4. Do not change production or preview while
working on the new glass design. First verify the branch and clean worktree,
then run the current focused glass/pointer/nav tests. Implement the
NEXT_PUBLIC_GLASS_LAB=1 localhost-only enhanced optics experiment described in
HANDOVER.md, using the existing delegated pointer loop and fallbacks; do not add
an ML model, full-screen WebGL shader, per-card listeners, or move text/icons.
Show the user the localhost result in Light/Warm/Dark and mobile/desktop before
any deployment. Separately, keep the iOS dynamic organisation-history export,
Supabase readiness evidence, and Ben/Stripe reconciliation as explicit open
items; do not paper over them in UI copy.
```

