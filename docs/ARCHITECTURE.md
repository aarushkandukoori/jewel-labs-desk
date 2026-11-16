# Jewel Labs Desk: architecture and module contracts

This file is the contract every module is built against. If you change a signature, change it here too.
`test/unit/site.test.js` checks the parts that drift most easily: the bridge list against `src/main/preload.cjs`,
the environment variables against the code, and every file path named in backticks.

## What the app does

A diamond house (exporter, importer, manufacturer or trader) installs the app on Mac or Windows. Its staff sign in to one
shared workspace for the house. Papers arrive (dropped in, a watched folder, a connected mailbox checked every 5
minutes, a WhatsApp chat export, a forwarded email). The agents then work on their own:

1. **Retrieval** pulls new mail, chat exports and folder files.
2. **Intake** classifies and reads every document (vision model first, OCR fallback). Every field keeps the spot on the
   page it came from.
3. **Records** files each paper under the right shipment and traces every stone: lab report, invoice line, packing
   list line, rough source (KP certificate, mining countries), export clearance, air waybill. This is the stone's
   **history**.
4. **Sanctions** screens every party against the OFAC SDN list.
5. **Origin** runs the compliance rules (0.5 ct threshold, natural vs lab-grown, KP countries, Russia anywhere,
   weights and totals, report number formats, destination rules for the EU and the US).
6. **Review** turns anything uncertain into one-line questions. Nothing uncertain reaches a pack.
7. **Paperwork** builds the papers: the origin pack (EU Due Diligence Statement draft or US CBP self-certification,
   stone list, evidence index, sources, originals in the order customs reads them) and the shipment handover record.

A person signs (the pack is versioned and locked with a SHA-256 hash) and sends it from the house's own mailbox, or
downloads it. Jewel Labs is never the filer: statuses are "ready to sign", "signed", "sent", never "filed".

Two views over the same data: **House** (customer staff: Home, Shipments, Papers, Stone history, Activity, Settings) and
**Desk** (Jewel Labs staff: every house, onboarding, approve or hold, metrics, audit trail).

## The agents and their files

Each agent's work lives in a stage file in `src/core/pipeline/`. `src/core/pipeline/runner.js` runs them in order (one run at a
time; a second request queues one follow-up run): Intake reads new documents a few at a time, Records files them, then
for each open shipment Sanctions, Origin and Review run, and Paperwork builds when autopilot is on and the shipment is
ready. `src/core/services.js` wires the stages to the store, the AI, the mailbox and the worker.

| agent | stage file | helpers it uses |
|-------|------------|-----------------|
| Retrieval | `src/core/pipeline/retrieval.js` (`addFiles`); `src/core/pipeline/worker.js` runs it every 5 minutes for the mailbox and the watched folder, and retries failed reads | `src/core/ingest/`, `src/core/mail/` |
| Intake | `src/core/pipeline/intake.js` (`readDocuments`) | `src/core/ai/`, `src/core/ocr/`, `src/core/records/locate.js` |
| Records | `src/core/pipeline/records-stage.js` (`runRecords`) | `src/core/records/` |
| Sanctions | `src/core/pipeline/sanctions-stage.js` (`screenShipmentParties`) | `src/core/sanctions/` |
| Origin | `src/core/pipeline/origin-stage.js` (`checkShipment`) | `src/core/rules/` |
| Review | `src/core/pipeline/origin-stage.js` (asks the questions in `checkShipment`), `src/core/pipeline/answers.js` (takes the answers) | |
| Paperwork | `src/core/pipeline/paperwork.js` (`buildIfReady`: with autopilot on, builds once the shipment is ready, else the papers wait for a person; `buildPapers`); a person signs and sends in `src/core/pipeline/signing.js`; the desk approves or holds in `src/core/pipeline/desk.js` | `src/core/papers/`, `src/core/mail/` |

## Repository layout

```
src/
  core/                 Pure Node ESM. No electron imports. Unit tested with node:test.
    types.js            Constants + JSDoc typedefs (doc types, field keys, agents, statuses, roles)
    config.js           Supabase URL + publishable key, AI models and limits, paths
    services.js         createServices(): the one object the Electron main process talks to
    metrics.js          computeMetrics(): usage numbers per house for the desk
    store/              index.js (entry), local.js (JSON files), cloud.js (Supabase sign-in, houses, invites, lease),
                        cloud-store.js (the same Store synced through Supabase), cloud-api.js (its Supabase calls),
                        rows.js (database rows <-> records), shared.js (helpers both stores use), disk.js (JSON files
                        written atomically)
    ingest/             index.js, detect (file types), zip, whatsapp, email (.eml), sheet (xlsx, csv), pdf (text layer
                        with word boxes)
    ocr/                tesseract.js with the bundled English model (no network)
    ai/                 index.js (createAI), client.js (OpenAI client: direct key or Jewel Labs proxy), schemas, prompts,
                        classify (rules first), normalize (cleans and cross-checks answers), heuristics (offline reader),
                        conversation (chats, emails and "Tell the agents" without AI), stone-lines, text
    records/            locate (value -> box), shipments (grouping), stones (matching), history; index.js
    rules/              compliance.js (the rules), consistency.js (cross-paper checks), goods.js (natural or lab-grown,
                        form, carats), fields.js (reading values), formats.js (HS codes, countries, report numbers)
    sanctions/          OFAC SDN: load (bundled snapshot + daily refresh), build, csv, normalize, jaro, countries, screen
    labs/               report-check URLs per lab, lab page parsing, comparison
    papers/             pdf-lib builders: pack, statements, packing-list, sign, refs, originals, layout, format;
                        templates.js (exact wording + official sources); fonts/ (Geist, with OFL.txt)
    mail/               IMAP polling (imapflow) and SMTP sending (nodemailer)
    pipeline/           the agents' stage files (see "The agents and their files"), plus runner.js (the order, the queue,
                        autopilot, the cloud lease), worker.js (5-minute loop), context.js (the toolbox every stage
                        gets), modules.js (loads core modules on first use), ask.js ("Tell the agents"), sample.js
                        (the SAMPLE shipment), shipment-save.js, files.js, folder-state.js
  main/                 Electron main process: main.js, env.js + switches.js (drop the switches a packaged copy must
                        not honour), state.js (sign-in, open workspace, services), ipc.js + preload.cjs (the bridge),
                        window.js (the window; serves the screens at app://jewel-labs/), menu.js, tray.js, notify.js,
                        settings.js, secrets.js (safeStorage), files.js, validate.js, openai-key.js, updates.js,
                        labs-window.js, rasterize.js and print.js (hidden pdf.js window: rasterize.html,
                        rasterize-page.mjs), log.js, fallback.html, e2e.js (test hooks, loaded only with JL_E2E=1)
  renderer/             The UI. Plain ES modules + Preact/htm (vendor/preact-htm.mjs). Runs in Electron and,
                        with demo/mock-api.js, in any browser (the website demo replays a recorded real run).
                        fonts/ (Inter and Geist, with OFL.txt), vendor/pdfjs/ (pdf.js)
backend/supabase/       migrations/*.sql, functions/ai (OpenAI proxy), functions/signup (sign-up), tests/ (local checks)
samples/                generate.js + lib/ write the SAMPLE shipments (fictional companies, labelled SAMPLE) and
                        answers.json (the answer key the eval uses)
site/                   GitHub Pages site (download page + live demo), built into site-dist/ by scripts/build-site.js
test/unit/              node:test suites, one per module (npm test)
test/e2e/               the real app driven with Playwright: flow.spec.mjs, app.spec.mjs, packaged.spec.mjs, helpers.mjs
test/fixtures/          small inputs for the tests (an OCR sample)
scripts/                build-site.js, eval.js (reading eval), record-run.js (records the demo run),
                        record-demo.js (demo video), make-icons.js
assets/                 logo.svg, icons, bundled OFAC snapshot (assets/ofac/)
docs/                   ARCHITECTURE.md (this file), DESIGN.md (the look)
.github/workflows/      test.yml (unit tests), pages.yml (website), release.yml (installers)
```

## Data model (all records are plain JSON objects with `id`, `workspaceId`, `createdAt`, `updatedAt`)

See `src/core/types.js` for the JSDoc typedefs. Collections in every workspace store:

| collection  | what it holds |
|-------------|---------------|
| `documents` | one per file: source, kind, docType, fields (with page + box), lines, declarations, `warnings` (what the reader could not confirm, such as a quote missing from the text layer, or "Read offline: ..." when an AI call failed), `readBy` (the model, "Offline reader" or "Paperwork"), `aiError` and `needsAiRead` (read by the offline reader because an AI call failed in a way that can work later: the worker reads it again with the AI, `aiRereads` times at most 3), status (`new`, `reading`, `read`, `error`), shipmentId |
| `shipments` | one per parcel: refs, parties, route, goods, totals, docIds, status, required papers |
| `stones`    | one per stone or lot: report number, lab, carat, colour, clarity, growth, line refs, KP, lab check, history |
| `checks`    | rule results per shipment (`shipmentId`, `code`, `severity`, `title`, `detail`, `evidence`) |
| `questions` | one-line questions for the clerk, with answer + who answered. `key` says where the answer goes: a field key (written into that field of `docId`, or onto the shipment), or a key only the rules read back from `shipment.answers` (`stone.<report>.<field>`, `stone.<report>.<field>.accepted`, `stone.<report>.onShipment`, `sanctions.<party>.<entry>`, `house.eori`); `doc.checkedBy` is written onto the agents' packing list draft. A keyed question the rules still ask with the same identity (`dedupeKey`) after a person answered it holds the shipment for the desk, so the rules stop asking after any answer they can use, or ask again with a new `dedupeKey` |
| `papers`    | generated PDFs: kind, ref (JL-EXP-1115-01), version, status, sha256, signer, sent to |
| `parties`   | counterparties seen in papers with their latest sanctions screening |
| `activity`  | audit trail: every step by an agent or a person, with time |
| `messages`  | house <-> Jewel Labs desk <-> agents messages ("Tell the agents") |
| `events`    | usage log for metrics (sign-in, upload, question answered, desk edit, pack signed, pack sent) |

Files (originals and generated PDFs) are stored by key `docs/<docId>/<fileName>` and `papers/<paperId>/<ref>-v<version>.pdf`.

## Module contracts

All functions are async unless noted. Coordinates are normalized 0..1 with origin at the top-left of the page.

### store (`src/core/store/index.js`)
```js
openLocalStore({ dir, workspaceId })            -> Store
createLocalWorkspace({ dir, profile })           -> Workspace     // creates dir/workspaces/<id>/
listLocalWorkspaces({ dir })                     -> Workspace[]
openCloudStore({ cloud, workspaceId, cacheDir }) -> Store         // same interface, backed by Supabase
// Store (an EventEmitter)
store.workspace()                -> Workspace
store.updateWorkspace(patch)     -> Workspace
store.list(collection, filter?)  -> object[]       // filter: (obj) => boolean (sync), or { field: value }
store.get(collection, id)        -> object | null
store.put(collection, obj)       -> object         // upsert by id; sets workspaceId/createdAt/updatedAt
store.remove(collection, id)     -> void
store.putFile(key, bytes, mime)  -> key
store.getFile(key)               -> Uint8Array
store.removeFile(key)
store.syncStatus() / store.flush()
store.on('change', fn)           // fn({ collection, id, op: 'put'|'remove', value }); collection 'workspace' for settings
store.close()
```
The cloud store also emits `'sync'` events (`{ online, realtime, pending, lastError, lastSyncedAt, ... }`) and marks
changes from other computers with `remote: true`.
`openCloudStore` also takes `userId` (who is signed in; read from `cloud.auth.session()` when not given): every change
waiting to be sent carries it, and changes another person made offline on this computer are set aside, never sent under
someone else's sign-in. The cloud store also has `store.reserveRef(stem, floor) -> number | null`: the number of a new
paper's ref ('JL-EXP-1116-' + number), handed out by the server (`backend/supabase/migrations/0007_paper_refs.sql`) so two
computers of a house never give two papers the same ref. null means the server has no such function yet; offline it
throws, and a first build waits.
`src/core/store/cloud.js` exports `createCloud({ url, anonKey, sessionStorage, fetch? })` returning
`{ auth: { signIn({email,password}), signUp({email,password,name,inviteCode?,houseName?}), signOut(), session(), onChange(fn) },
   workspaces: { list(), create(profile), join(code), invite(workspaceId, role) -> {code}, revoke(code) -> boolean, members(workspaceId) },
   lease: { acquire(workspaceId, holder, ttlSeconds) -> boolean, release(workspaceId, holder) },
   aiProxyUrl, accessToken(), client, url, close() }`.

### ingest (`src/core/ingest/index.js`)
```js
ingestFile({ name, bytes, source, maxUnpackedBytes? }) -> { items: IngestItem[] }   // never throws: a bad file gives an item with `error`
pdfInfo(bytes)  -> { pages, hasTextLayer, text, pageTexts: string[], words: Word[], pageSizes: [{w,h}], pageHasText: boolean[], error? }
detectMime(name, bytes) -> string        (sync)
kindForMime(mime) -> 'pdf'|'image'|'sheet'|'text'|'email'|'other'   (sync)
sha256(bytes)   -> hex string            (sync)
decodeText(bytes) -> string              (sync)
parseChat(text, { title?, fileNames? }) -> { title, dateOrder, messages }   (sync)
```
`IngestItem = { name, mime, kind: 'pdf'|'image'|'sheet'|'text'|'email'|'chat'|'other', bytes, sha256, source, parent?,
chat?: { title, messages: [{ at, author, text, attachment? }] }, email?: { from, to, cc, subject, date, text },
sheet?: { sheets: [{ name, rows }], text }, text?, error? }`.
Zips expand (one nested level; zips and emails nest at most 4 deep), WhatsApp exports are detected (`_chat.txt` or
"WhatsApp Chat" in the name; iOS `[5/11/26, 11:25:43 PM] Name: text` and Android `5/11/26, 23:25 - Name: text` formats;
`<attached: file>` and `file (file attached)` attachments map to the files in the zip, and each attachment keeps who sent
it and when). A chat exported without media (a lone `.txt`) becomes a chat item too. `.eml` files become an email item
plus one item per attachment. `__MACOSX` and dotfiles are dropped. All the zips in one file may unpack to 512 MB
together (`maxUnpackedBytes`); past that the file becomes an item with an `error`. `pdfInfo` never throws: a broken or
locked PDF gives `pages: 0` and an `error`; `pageSizes` are in points.

### ocr (`src/core/ocr/index.js`)
```js
ocrImage(bytes, { page? }) -> { text, words: Word[], width, height, error? }   // tesseract.js + bundled eng model, no network
terminateOcr()
ocrStatus() -> { running, imagesRead }          (sync)
setOcrLimits({ idleMs?, imagesPerWorker? })     (sync, for tests; no argument puts the defaults back)
modelDir() / ocrOptions() / outsideAsar(path)   (sync)   // where the model and worker live, in dev and packaged
```
`Word = { text, page, x0, y0, x1, y1, conf? }` (`conf` 0..1). `ocrImage` never throws: on failure the result is empty and
carries an `error`. `page` is the page number put on the words (for a rendered PDF page, 1 by default). Long dashes OCR
reads become plain hyphens. One worker reads one image at a time; its memory only grows, so it stops after a minute
without work and is replaced after 50 images.

### ai (`src/core/ai/index.js`)
```js
createAI({ mode: 'direct'|'proxy'|'off'|'mock', apiKey?, proxyUrl?, getAccessToken?, workspaceId?, model?, models?,
           fetch?, timeoutMs?, tries?, retryBaseMs?, mockHandler? }) -> AI
AI.available, AI.mode, AI.model
AI.lastError                               -> { code, message, at } | null   // the last AI problem, for the app to show
AI.classify(item, { textHint })            -> { docType, confidence, reason }
AI.extract(item, docType, { textHint, pageTexts?, pageImages?, textSource?: 'layer'|'ocr', house? }) -> Extraction
AI.readChat(chat)                          -> { relevant: [{at,author,text,why}], requests: [{text, ref}], packing: [{ref, lines: Line[]}], refs: string[], readBy? }
AI.readEmail(email)                        -> { relevant: [...], requests: [...], refs: string[], packing, readBy? }
AI.route(text, { shipments, openQuestions }) -> { intent, shipmentRef, kinds, reply }
AI.draftPackingList({ shipment, chatLines, emails, documents }) -> { lines: Line[], sources: [{kind, ref, quote}], notes }
AI.usage()                                 -> { calls, inputTokens, outputTokens }   (sync)
AI.check()                                 -> { ok, mode, model, code?, message }    // one tiny call to test the key or sign-in
```
`Extraction = { docType, summary, fields: Field[], lines: Line[], declarations: string[], readBy, warnings: string[], aiError? }`
(`readBy` is `'ai:<model>'`, `'offline'` or `'mock'`; `warnings` lists what the cross-check against the text layer and the
offline reader could not confirm),
`Field = { key, value, quote, page, confidence, box? }` (key from `FIELD_KEYS`), `Line = { lineNo, description,
reportNumber, lab, shape, carat, color, clarity, pieces, rate, amount, growth, quote }` (missing values are `null`).
Mode `off` (no key and no sign-in) uses the offline heuristic reader (`src/core/ai/heuristics.js`, regex over the text
layer or OCR text), so the app still works, less accurately. Every method falls back to the offline reader when a call
fails; from `extract`, `readChat` and `readEmail` that answer carries `readBy: 'offline'` and a "Read offline: ..."
warning, and `aiError` (the error's code) when the failure can pass (not a refused key, say), so Intake marks the paper
`needsAiRead` and the worker reads it again once the AI is back. A `readChat` or `readEmail` the model answered carries
`readBy: 'ai:<model>'`. Every answer from the AI sets `AI.lastError` back to null.
Mode `mock` takes a `mockHandler(task, args)` for tests.
Mode `proxy` needs `workspaceId`: the house id the call is counted against (a string, or a function that returns the
open house's id). Proxy protocol: `POST {proxyUrl}` with `Authorization: Bearer <user JWT>` and
`x-jl-workspace: <house id>`, body = an OpenAI Chat Completions request; the response is OpenAI's own status and JSON.
The proxy answers 400 `bad_workspace` without the header, 403 `not_member` for a house the person is not in, 413 for a
body over 25 MB, and 429 `daily_limit` when the house used its calls for the day; its own errors use OpenAI's shape
`{ error: { message, type, code } }`. The client never sends a body the proxy would refuse for its size
(`AI_PROXY_MAX_BODY_BYTES` in `src/core/config.js`): it fails with `too_large` instead.

### records (`src/core/records/*.js`)
```js
locate(words, quote, { page? })            -> { page, box: [x0,y0,x1,y1], score } | null   (sync)
locateFields(words, fields)                -> fields   (sync; src/core/records/locate.js: fills page + box from quote or value)
groupShipments({ documents, shipments, house }) -> { shipments: Shipment[], assignments: { [docId]: shipmentId } }  (sync)
matchStones({ shipment, documents })        -> { stones: Stone[], issues: [{ code, detail, ref, docIds }] }  (sync)
buildHistory({ stone, shipment, documents, papers }) -> HistoryEvent[]   (sync)
```
`src/core/records/stones.js` also exports `shipmentDocuments(shipment, documents)` (the shipment's own papers, without an
agents' packing list draft the house's own list replaced and without a grading report the house said is not part of the
shipment), `isAgentDraft(doc)`, `isUncheckedDraft(doc)` (a draft no person checked: it does not count as the packing list
and stays out of the envelope), `stoneAnswerKey(ref, field)`, `shipmentAnswer(shipment, key)` and
`onShipmentAnswer(shipment, ref)` (all sync).
`locate` compares tokens (letters and digits, lower case, no accents); numbers are written one way ("1,02" equals
"1.02", "12,345.00" equals "12345"), and digits OCR reads as letters (O for 0, l for 1 ...) still match. Short quotes
must be found whole; long ones (an address) may be found in part (60% of their tokens in order, every number among
them) or over up to 4 lines of one column. The page the reader named gets a small head start.

### rules (`src/core/rules/compliance.js`, `formats.js`)
```js
RULES_VERSION
RULE_SOURCES                          // the official texts the rules cite (AWDC guidelines, CBP CSMS #61912001)
classifyGoods({ documents, stones }) -> { nature: 'natural'|'lab-grown'|'mixed'|'unknown', form: 'rough'|'polished'|'jewelry'|'mixed'|'unknown', hsCodes, maxCarat,
  stonesAtOrAboveHalf, loose, naturalSizes, lotsMayReachHalf, sizeUnknown, ... }   // loose: forms of loose stones next to jewellery
evaluate({ shipment, documents, stones, house, screenings, now }) ->
  { checks: Check[], required: [{ kind, reason, signer, regime }], questions: QuestionDraft[], status, summary: { passed, total },
    goods, regime }                   // goods as classifyGoods; regime of the destination: 'EU'|'US'|'UK'|'OTHER'
regimeOf(country) -> 'EU'|'US'|'UK'|'OTHER'   (sync)
```
`natureFromText(text)` (`formats.js`) reads natural or lab-grown the same way for the rules, the offline reader and the
AI layer: "not lab-grown", "non-synthetic", "no CVD/HPHT" and "HPHT treated natural" are natural, and a text naming both
gives null (a person decides). Papers the offline reader read because the AI failed give a `read_offline` warning and a
question to confirm them.

### sanctions (`src/core/sanctions/index.js`)
```js
loadSdn({ cacheDir, fetch?, maxAgeHours = 24 }) -> SdnIndex { count, date, source, entries }
screen(name, index, { country?, includeVessels? }) -> { name, status: 'clear'|'review'|'match', best: { sdnName, uid, programs, score, type, matchedName, matchedOn, countries } | null, compared, listDate, note }  (sync)
```
Vessel and aircraft entries are compared only with `includeVessels: true`; a party on the papers is a person or a
company.
A `clear` result only means no close name was on the list of that date. It never proves a party is safe.

### labs (`src/core/labs/index.js`)
```js
detectLab(reportNumber, labHint) -> 'GIA'|'IGI'|'HRD'|'GCAL'|null     (sync)
reportCheckUrl(lab, reportNumber) -> string | null                    (sync)
parseLabPage(lab, pageText)       -> { found, reportNumber?, carat?, color?, clarity?, shape?, growth? }  (sync)
compareLab(stone, parsed)         -> { status: 'match'|'mismatch'|'not_found', diffs: [{ field, ours, lab }] } (sync)
```
The lookup itself happens in Electron (`src/main/labs-window.js`): a visible window loads the lab's official report
check page; the person solves any challenge the site shows; the page text is read and passed to `parseLabPage`.

### papers (`src/core/papers/index.js`)
```js
nextRef(kind, date, existingRefs) -> 'JL-EXP-1115-01'   (sync)
buildPack({ kind: 'export_pack'|'import_pack', shipment, documents, stones, checks, required, house, getFile, ref, version, status }) -> { bytes, sha256, pages, contents }
buildStatement({ kind: 'eu_dds'|'us_cbp_certificate'|'g7_gf_declaration', shipment, documents, stones, house, status, ref, version }) -> { bytes, sha256 }
buildPackingListDraft({ shipment, lines, sources, house, ref?, version?, status?, checkedBy?, checkedAt? }) -> { bytes, sha256 }
signPdf(bytes, { name, title, signedAt, signatureDataUrl? }) -> { bytes, sha256 }
TEMPLATES   // exact statement wording + official source URLs
```

### mail (`src/core/mail/index.js`)
```js
PROVIDERS                                           // gmail, outlook, icloud, yahoo, zoho, custom
connectMailbox({ provider, email, appPassword, host?, port? }) -> Mailbox
Mailbox.test() ; Mailbox.close()
Mailbox.fetchSince(date, { domains, limit?, afterUid?, uidValidity? }) -> [{ uid, messageId, from, subject, date, eml }]
                                                    // oldest first; the list also carries the next cursor: .uidValidity, .lastUid, .more,
                                                    // and .tooBig: messages over 50 MB, not downloaded ([{ uid, from, subject, size }])
sendMail({ provider, email, appPassword, to, cc, subject, text, attachments }) -> { messageId }
cleanDomains(domains) -> string[] ; matchesDomains(envelope, domains) -> boolean   (sync; src/core/mail/domains.js)
```
Mail comes in only from senders (or people copied) at the domains listed for the mailbox (brokers, labs, shippers;
never the house's own domain): no domains means no mail at all.
The mailbox, its domains and how far the agents got in it belong to the computer, never to the shared workspace.

### services (`src/core/services.js`)
```js
createServices({ store, ai, sanctionsLoader, ocr, labsVerify?, rasterize?, notify?, paths, deviceId, clock?, lease?,
                 pace?, modules?, pollMinutes?, getMembers?, parallel?, pageDrawTimeoutMs? }) -> Services
// paths: { cacheDir, samplesDir?, userData? }; pace: ms between live field events (0 in tests); modules: fake core
// modules for tests; pollMinutes: worker interval (5); getMembers: the house's logins, for metrics; parallel: papers
// read at once (3; the demo recording uses 1); pageDrawTimeoutMs: how long drawing one page of a scan may take (60 s)
Services.events            // EventEmitter: 'agent', 'activity', 'change', 'notify'
Services.addFiles(files)   // [{ name, bytes, source }] -> { documentIds, duplicates, failed }
Services.run({ shipmentId?, reason })
Services.idle()            // resolves when every run, background step and live event is done
Services.autopilot.get() / .set(on, by)
Services.ask(text, { shipmentId?, by }) -> { reply, actions, steps, intent, shipmentId }
Services.answerQuestion(id, answer, by) / dismissQuestion(id, by)
Services.buildPapers(shipmentId, { kinds?, by })
Services.signPaper(paperId, { name, title, signatureDataUrl? }, by)
Services.sendPaper(paperId, { to, cc, subject, body }, by)
Services.desk.queue() / approve(paperId, message, by, changes?) / hold(paperId, message, by, changes?)
Services.history(reportNumber) -> { stone, shipment, events }
Services.verifyStone(stoneId, by) -> labCheck
Services.metrics() -> { houses: [...], totals }
Services.mail.connect({ provider, email, appPassword, domains, ... }) / status() / disconnect() / pollNow()
                           // status(): { connected, email, domains, lastPollAt, lastSeenAt, lastError, needsPassword, needsDomains, ... }
Services.folder.set(path) / status()   // status(): { path, watching, lastScanAt, files, lastError, problems: [{ file, reason }] }
Services.worker.start() / stop() / status() / tick()
Services.loadSample({ later? }) / resetSample()   // later: true delivers the papers that arrive late (the packing list)
Services.shutdown()
```
`'agent'` events drive the live view: `{ agent, action: 'start'|'read'|'field'|'check'|'screen'|'question'|'paper'|'done'|'error',
docId?, shipmentId?, page?, key?, label?, value?, box?, message, at }`. `'notify'` events: `{ kind, title, body, shipmentId, paperId, at }`.

## Electron bridge (`window.jl`, defined in `src/main/preload.cjs`)

```
jl.app.info() .openExternal(url) .showItem(path) .qr(text) -> dataUrl .checkUpdate() -> { latest, url, download } | null
jl.app.pathForFile(file) -> path          (sync, in the preload: the path of a dropped File, '' when it is not on disk)
jl.auth.status() .signIn({ email, password }) .signUp({ email, password, name?, inviteCode?, houseName? }) .signOut()
jl.workspaces.list() .create(profile) .select(id) .current() .update(patch) .join(code) .invite(role) .revoke(code) .members()
jl.docs.pick() .add(files) .list(q) .get(id) .file(id) .remove(id)
jl.shipments.list(q) .get(id) .update(id, patch)
jl.stones.list(q) .history(reportNumber) .verify(stoneId)
jl.checks.list(q)
jl.parties.list(q)
jl.questions.list(q) .answer(id, answer) .dismiss(id)
jl.papers.list(q) .build(shipmentId, kinds) .file(id) .open(id) .print(id) .sign(id, sig) .send(id, mail) .save(id)
jl.agents.run(q) .ask(text, q) .autopilot(on?)
jl.activity.list(q)
jl.messages.list(q) .send(msg)
jl.desk.queue() .approve(paperId, message, changes?) .hold(paperId, message, changes?) .houses() .onboard(profile)
jl.sanctions.status() .screen(name) .refresh()
jl.mail.connect(opts) .status() .disconnect() .pollNow()
jl.folder.choose() .status()
jl.settings.get() .set(patch)
jl.metrics.get()
jl.demo.load({ later? }) .reset()
jl.on(event, fn) -> unsubscribe     // 'agent' | 'activity' | 'change' | 'notify' | 'auth' | 'sync'
```
Every call returns a Promise; errors come back as `{ error: message }` objects, never thrown across the bridge.
`list(q)` takes `q = { <field>: value or [values], search?, limit? }` and returns newest first. `docs.add` takes File
objects from a drop or a file input as well as `[{ path }]` or `[{ name, bytes }]`; the main process reads only paths
that were dropped or chosen in this window. `desk.*` answers only for Jewel Labs desk staff, and `desk.approve` only for a
signed-in desk account (`canApprove` in `jl.app.info()` and `jl.auth.status()`): in a local workspace nobody can
release a held pack. `changes` lets the desk correct fields before approving or holding:
`{ fields: { 'goods.destinationCountry': 'BE' } }`.
`jl.demo.load()` adds the SAMPLE papers except the late ones; `jl.demo.load({ later: true })` delivers those.

`jl.app.info()` returns `{ name, version, platform, arch, isDev, e2e, locale, versions, logFile, site, repo, ready,
startError, mode, workspaceId, sample, cloud, signedIn, role, deskAllowed, canApprove, autopilot, secureStorage,
ai: { mode, model, available, calls, lastError: { code, message, at } | null } }`. `ai.calls` counts the AI calls since
the workspace opened; `ai.lastError` is the last AI problem in plain words (never the key).

The renderer falls back to `src/renderer/demo/mock-api.js` when `window.jl` is missing (website demo). The mock adds
`jl.demo.status()` and `jl.demo.skip()`; its run format is in `src/renderer/demo/README.md`.

## Development and test environment variables

None of these is needed to use the app, and an installed copy honours none of them: it never reads a developer key, and
`src/main/switches.js` removes the others at start (`JL_E2E*`, `JL_USER_DATA` and `JL_SUPABASE_*`). Only a self-check build
keeps the test switches (`JL_E2E`, `JL_E2E_*`, `JL_USER_DATA`): `test/e2e/packaged.spec.mjs` needs one, built with
`npx electron-builder --mac --arm64 --publish never -c.extraMetadata.selfCheck=true`. `src/main/e2e.js` ships in every copy
but is loaded only with that build-time flag, which sits inside the integrity-checked app.asar.

| variable | read by | what it does |
|----------|---------|--------------|
| `JL_DEV_OPENAI_KEY_FILE` | `src/main/main.js` (development only) | a file holding a developer's own OpenAI key; the agents then read in `direct` mode. The key stays in memory, never logged or saved. `test/e2e/flow.spec.mjs` and `scripts/record-demo.js` pass `~/.config/jewel-labs/openai_key` unless it is set |
| `OPENAI_API_KEY` | `src/main/main.js` (development only, not with `JL_E2E=1`) | the same, from the environment, when `JL_DEV_OPENAI_KEY_FILE` is not set |
| `JL_USER_DATA` | `src/main/main.js` | keeps the app's data (workspaces, settings, logs) in this folder instead of the usual one |
| `JL_E2E` | `src/main/main.js` | `1` = test mode: data in a temp folder unless `JL_USER_DATA` is set, test hooks from `src/main/e2e.js` (`globalThis.__jlTest`), the Open and Save dialogs answer on their own, no OFAC download, no notifications, no launch at login |
| `JL_E2E_OPEN_FILES` | `src/main/e2e.js` | files the Open dialog answers with (separated by the path delimiter) |
| `JL_E2E_SAVE_DIR` | `src/main/e2e.js` | folder the Save dialog saves into |
| `JL_E2E_REPORT` | `src/main/main.js`, `src/main/e2e.js` | after start-up the app checks itself (loads the sample, lets the agents finish, OCR, draws a PDF page) and writes the result to this file as JSON |
| `JL_E2E_QUIT` | `src/main/main.js` | `1` = quit once that report is written |
| `JL_SUPABASE_URL`, `JL_SUPABASE_PUBLISHABLE_KEY` | `src/core/config.js` | another Supabase project (see `backend/supabase/README.md`); `JL_SUPABASE_ANON_KEY` is the old name of the key switch, still read |
| `JL_CHROMIUM` | `scripts/record-run.js`, `test/unit/renderer.test.js` | the Chromium to use instead of Playwright's own |
| `JL_UI_SHOTS` | `test/unit/renderer.test.js` | `1` = also screenshot the main screens into `test/.tmp/` (slow) |
| `PGLITE_DIR` | `backend/supabase/tests/check-sql.mjs` | the folder where PGlite is installed, for the SQL check |

`scripts/eval.js` and `scripts/record-run.js` read the key from `~/.config/jewel-labs/openai_key` themselves. Every
script reads the key at run time and never prints it.

## Security rules

- No API key ever ships in the app or the repo. The Jewel Labs key lives in Supabase (Edge Function secret).
  A house may paste its own OpenAI key in Settings; it is stored with Electron `safeStorage`.
  A developer's own key comes from `JL_DEV_OPENAI_KEY_FILE` (see above), outside the repo.
- Row-level security: a user only reads workspaces they are a member of; desk users read all houses.
- Renderer runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; strict CSP. The screens load
  from `app://jewel-labs/`, which serves only the renderer folder, and only those pages may call the bridge.
- A packaged copy honours no development or test switch (see above) and does not start with a remote-debugging or
  inspector switch.
- Mailbox app passwords are stored with `safeStorage`, never in plain JSON.
