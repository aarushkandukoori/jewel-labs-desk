# Jewel Labs Desk

The desktop app (Electron, macOS and Windows) for Jewel Labs. A diamond house's export staff install it. Papers arrive
by drop, a watched folder, a mailbox the agents check every 5 minutes, or a WhatsApp chat export. Seven agents read
every page (an OpenAI vision model first, OCR as the fallback), file each paper under its shipment, trace every
stone's history, screen the parties on the OFAC SDN list, run the compliance rules (EU Due Diligence Statement on
Diamond Origin, US CBP self-certification, Kimberley Process, Russia), ask one-line questions about anything
uncertain, and build the origin pack. A person signs it and sends it from the house's own mailbox.

A pack is **ready to sign**, **signed** or **sent**. Uncertain points become questions first, and a pack with a failed
check is **held for review** until a person at Jewel Labs approves it. Jewel Labs never files anything: no status in
the app says "filed"; the house or its broker lodges the papers.

The website (download page, and a live demo that replays a recorded run on fictional SAMPLE papers):
https://aarushkandukoori.github.io/jewel-labs-desk/

## Install and run

Needs Node 22.12 or later.

```sh
npm ci
npm start
```

`npm start` opens the app in development. Without an OpenAI key or a sign-in the agents use the offline reader
(regular expressions and OCR), so everything works, less accurately. To see it work, choose **Try the sample
shipment** on the first screen.

The SAMPLE shipments (fictional companies, every paper labelled SAMPLE) are in `samples/sample-shipment/`, with their
answer key in `samples/answers.json`. `npm run samples` writes them again; the output is the same on every run.

## How the agents work

| agent | what it does | file |
|-------|--------------|------|
| Retrieval | pulls new mail, chat exports and folder files; skips papers already on file | `src/core/pipeline/retrieval.js`, `src/core/pipeline/worker.js` |
| Intake | classifies and reads every document; every field keeps its spot on the page | `src/core/pipeline/intake.js` |
| Records | files each paper under its shipment and traces every stone | `src/core/pipeline/records-stage.js` |
| Sanctions | screens every party against the OFAC SDN list | `src/core/pipeline/sanctions-stage.js` |
| Origin | runs the compliance rules | `src/core/pipeline/origin-stage.js` |
| Review | turns anything uncertain into one-line questions | `src/core/pipeline/origin-stage.js`, `src/core/pipeline/answers.js` |
| Paperwork | builds the origin pack and the statements; a person signs and sends | `src/core/pipeline/paperwork.js`, `src/core/pipeline/signing.js` |

`src/core/pipeline/runner.js` runs them in order and `src/core/services.js` wires them together. The module contracts,
the data model and the bridge between the screens and the app are in `docs/ARCHITECTURE.md`; the look is in
`docs/DESIGN.md`.

## Checks

| check | command | needs |
|-------|---------|-------|
| unit tests | `npm test` | nothing: offline, a few seconds |
| reading eval on the SAMPLE shipments | `npm run eval` (`node scripts/eval.js`) | an OpenAI key in `~/.config/jewel-labs/openai_key` |
| the same without AI | `npm run eval:offline` | nothing |
| end-to-end flows on the real app | `npm run e2e` (`node test/e2e/flow.spec.mjs`, or add `A` or `B`) | flow A: the key file (or `JL_DEV_OPENAI_KEY_FILE`); flow B: the internet |
| the packaged Mac app | `npm run e2e:packaged` (`node test/e2e/packaged.spec.mjs [dmg]`) | macOS and a self-check `.dmg` (see Installers) |
| the Supabase backend, locally | `npm run check:backend` | PGlite in `PGLITE_DIR` and Deno (see `backend/supabase/README.md`) |

Eval options (after `npm run eval --`): `--offline`, `--proxy` (uses the Jewel Labs AI proxy with a jl-test account),
`--only A` (one shipment: A, B or C), `--cache` (reuses saved AI answers). The report lands in `test/.tmp/eval-report.md`.
Flow B and `--proxy` create test accounts on the live Supabase project, always `jl-test-...@example.com`, through the
`signup` function. `node test/e2e/app.spec.mjs` is a quick smoke test of the app window.

## Installers

```sh
npm run dist:mac    # dist/Jewel-Labs-mac-arm64.dmg and dist/Jewel-Labs-mac-x64.dmg
npm run dist:win    # dist/Jewel-Labs-windows-setup.exe
npm run clean:builds
```

`npm run dist:mac` ends with `npm run clean:builds` (`node scripts/clean-builds.js`). electron-builder leaves the
unpacked app next to each `.dmg` (`dist/mac/` and `dist/mac-arm64/`, the same in `dist-selfcheck/`), and macOS lists
every `Jewel Labs.app` it finds, so after a few builds the Mac shows several "Jewel Labs" apps. The script tells macOS
to forget those apps and deletes the folders; the `.dmg` files stay. Run it by hand after any other build. It refuses
folders outside the repository.

An installed copy ignores the test and back-end switches (`JL_E2E*`, `JL_USER_DATA` and `JL_SUPABASE_*`, see
`src/main/switches.js`), so `test/e2e/packaged.spec.mjs` needs a self-check build of the Apple silicon `.dmg`:
`npx electron-builder --mac --arm64 --publish never -c.extraMetadata.selfCheck=true`. Use it for that check only, never
for a release. (`src/main/e2e.js` ships in every copy but loads only in a self-check build.)

### Installing on a Mac

The app is signed ad hoc and not yet notarized by Apple (there is no Apple Developer ID yet), so how it is downloaded
matters:

- **From Terminal, no warning.** `curl -fsSL https://aarushkandukoori.github.io/jewel-labs-desk/install.sh | bash`
  runs `site/install.sh`: it picks Apple silicon or Intel, downloads the `.dmg` from the latest release, checks it
  against the sha512 in the release's `latest-mac.yml`, copies the app into `/Applications` (or `~/Applications`), and
  opens it. A file fetched with curl is not marked as downloaded from the internet, so macOS opens the app without
  asking. The script never uses sudo and changes no security setting.
- **The `.dmg` from a browser.** macOS says it cannot verify the app is free of malware. Click Done (not Move to
  Trash), then System Settings > Privacy & Security > Open Anyway, then Open. On macOS 15 and later right-click > Open
  no longer skips this step.

To try the script without touching `/Applications`: `JL_DMG_FILE` (a local `.dmg` instead of the download),
`JL_LATEST_YML` (a local checksum file), `JL_INSTALL_DIR` (where to install) and `JL_NO_OPEN=1` (do not open the app).

### Turning on Apple signing

When the five secrets below exist in the GitHub repository (Settings > Secrets and variables > Actions), the release
workflow signs the Mac app with the Developer ID, has Apple notarize it and staples the ticket, so a browser download
opens with no warning. Without them it builds ad hoc exactly as now. Its "Check the Mac apps" step verifies the result
either way.

| secret | what it holds |
|--------|---------------|
| `MAC_CERT_P12_BASE64` | the Developer ID Application certificate exported as a `.p12`, as base64 (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CERT_PASSWORD` | the password of that `.p12` |
| `APPLE_API_KEY_P8` | the full text of the App Store Connect API key file (`AuthKey_XXXX.p8`) |
| `APPLE_API_KEY_ID` | that key's ID |
| `APPLE_API_ISSUER` | the issuer ID shown above the keys |

Only the owner can do these three things:

1. Enrol in the Apple Developer Program as an individual (an Apple Account with two-factor sign-in, real legal name,
   $99 a year).
2. As Account Holder, create a Developer ID Application certificate (developer.apple.com > Certificates > + >
   Developer ID Application, with a signing request made in Keychain Access), install it, and export it from Keychain
   Access as a `.p12` with a password.
3. In App Store Connect > Users and Access > Integrations, create a Team API key (Developer role), download the `.p8`
   (it downloads only once) and note the key ID and issuer ID. Then add the five secrets and push a new version tag.

## Releases

1. Change `"version"` in `package.json` (say `1.0.1`), commit it and push it.
2. Push a tag with the same version: `git tag v1.0.1 && git push origin v1.0.1`.

`.github/workflows/release.yml` then creates the GitHub release and uploads the Mac and Windows installers. It stops
when the tag and `package.json` do not match. The website's download buttons always point at the latest release.

## Website

- `npm run site:build` builds `site/`, the app's screens (for the live demo) and the SAMPLE papers into `site-dist/`.
- `.github/workflows/pages.yml` deploys it to GitHub Pages on every push to `main` that touches the site, the screens,
  the samples or the build script, or by hand from the Actions tab (one-time setup: Settings > Pages > Source: GitHub
  Actions).
- `npm run demo:run` (`node scripts/record-run.js`) records a new real run of the agents for the live demo, with the
  key in `~/.config/jewel-labs/openai_key`. It writes `src/renderer/demo/sample-run.json` and the files it points to;
  `--cache` reuses saved AI answers and `--verify` only replays the recording. The format is in
  `src/renderer/demo/README.md`.
- `npm run demo:video` (`node scripts/record-demo.js`) records a walkthrough video of the real app into
  `test/.tmp/demo/demo-raw.webm` (needs the key file and ffmpeg). The site's "Watch it work" section turns on once a
  finished video is at `site/media/demo.mp4`.

## Supabase (multi-user houses)

A house's shared records, the sign-up function and the AI proxy live in Supabase. Setup, migrations, the Edge
Functions (`ai` and `signup`), secrets and the local checks are in `backend/supabase/README.md`. The project URL and
its publishable key are in `src/core/config.js`; both are public, and row-level security protects the data.

## The OpenAI key

- The Jewel Labs key lives only in Supabase, as the Edge Function secret `OPENAI_API_KEY` that the `ai` function uses.
  Signed-in people use it through that proxy, which counts the calls per house.
- A house may paste its own key in Settings. The app stores it encrypted with Electron `safeStorage`.
- Developers: `npm start` reads a key from the file named by `JL_DEV_OPENAI_KEY_FILE` (or from `OPENAI_API_KEY`). The
  eval, e2e and demo scripts use `~/.config/jewel-labs/openai_key` (the e2e and video scripts take
  `JL_DEV_OPENAI_KEY_FILE` instead when it is set). A packaged app never reads a developer key.
- Never put a key in the app, the repository or a log. All development variables are listed in `docs/ARCHITECTURE.md`.

## License

Copyright (c) 2026 Jewel Labs. All rights reserved (see `LICENSE`). The third-party components the app and the
website ship, and their licenses, are listed in `THIRD_PARTY_NOTICES.md`.
