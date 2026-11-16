# Jewel Labs Desk: architecture and module contracts

This file is the contract every module is built against. If you change a signature, change it here too.

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

## Repository layout

```
src/
  core/                 Pure Node ESM. No electron imports. Unit tested with node:test.
    types.js            Constants + JSDoc typedefs (doc types, field keys, agents, statuses, roles)
    config.js           Endpoints, model defaults, paths helpers, versions
    store/              local.js (JSON files), cloud.js (Supabase), index.js
    ingest/             detect, zip/WhatsApp/eml/xlsx/pdf unpacking, pdf text layer with word boxes
    ocr/                tesseract.js with the bundled English model (no network)
    ai/                 OpenAI client (direct key or Jewel Labs proxy), schemas, prompts, classify, extract,
                        chat/email reading, orchestrator ("Tell the agents"), offline heuristic reader
    records/            locate (value -> box), shipments grouping, stone matching, history
    rules/              compliance.js (deterministic rules), formats.js (HS codes, countries, report numbers)
    sanctions/          OFAC SDN load (bundled snapshot + daily refresh), normalize, fuzzy screen
    labs/               report-check URLs per lab, lab page parsing, comparison
    papers/             pdf-lib builders: packs, statements, handover record, packing list draft; templates.js
    mail/               IMAP polling (imapflow) and SMTP sending (nodemailer)
    pipeline/           agents.js (stage functions), runner.js (queue, autopilot, lease), worker.js (5-minute loop)
    services.js         createServices(): the one object the Electron main process talks to
  main/                 Electron main process: main.js, ipc.js, preload.cjs, tray, labs-window.js, rasterize.js
  renderer/             The UI. Plain ES modules + Preact/htm (vendor/preact-htm.mjs). Runs in Electron and,
                        with demo/mock-api.js, in any browser (the website demo replays a recorded real run).
backend/supabase/       migrations/*.sql, functions/ai (OpenAI proxy), functions/signup (invite sign-up)
samples/                generate.js + generated SAMPLE shipment (fictional companies, labelled SAMPLE)
site/                   GitHub Pages site (download page + live demo)
test/unit/              node:test suites, one per module
scripts/                build-site.js, record-demo.js, make-icons.js
assets/                 logo.svg, icons, bundled OFAC snapshot (assets/ofac/)
```

## Data model (all records are plain JSON objects with `id`, `workspaceId`, `createdAt`, `updatedAt`)

See `src/core/types.js` for the JSDoc typedefs. Collections in every workspace store:

| collection  | what it holds |
|-------------|---------------|
| `documents` | one per file: source, docType, fields (with page + box), lines, status |
| `shipments` | one per parcel: refs, parties, route, goods, totals, docIds, status, required papers |
| `stones`    | one per stone or lot: report number, lab, carat, colour, clarity, growth, line refs, KP, lab check, history |
| `checks`    | rule results per shipment (`shipmentId`, `code`, `severity`, `title`, `detail`, `evidence`) |
| `questions` | one-line questions for the clerk, with answer + who answered |
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
// Store
store.workspace()                -> Workspace
store.updateWorkspace(patch)     -> Workspace
store.list(collection, filter?)  -> object[]       // filter: (obj) => boolean (sync)
store.get(collection, id)        -> object | null
store.put(collection, obj)       -> object         // upsert by id; sets workspaceId/createdAt/updatedAt
store.remove(collection, id)     -> void
store.putFile(key, bytes, mime)  -> key
store.getFile(key)               -> Uint8Array
store.on('change', fn)           // fn({ collection, id, op: 'put'|'remove', value })
store.close()
```
`src/core/store/cloud.js` exports `createCloud({ url, anonKey, sessionStorage })` returning
`{ auth: { signIn({email,password}), signUp({email,password,name,inviteCode?,houseName?}), signOut(), session(), onChange(fn) },
   workspaces: { list(), create(profile), join(code), invite(workspaceId, role) -> {code}, members(workspaceId) },
   lease: { acquire(workspaceId, holder, ttlSeconds) -> boolean, release(workspaceId, holder) },
   aiProxyUrl, accessToken() }`.

### ingest (`src/core/ingest/index.js`)
```js
ingestFile({ name, bytes, source }) -> { items: IngestItem[] }
pdfInfo(bytes)  -> { pages, hasTextLayer, text, pageTexts: string[], words: Word[], pageSizes: [{w,h}] }
detectMime(name, bytes) -> string        (sync)
sha256(bytes)   -> hex string            (sync)
```
`IngestItem = { name, mime, kind: 'pdf'|'image'|'sheet'|'text'|'email'|'chat'|'other', bytes, sha256, source, parent?,
chat?: { title, messages: [{ at, author, text, attachment? }] }, email?: { from, to, cc, subject, date, text },
sheet?: { sheets: [{ name, rows }], text }, text? }`.
Zips expand (one nested level), WhatsApp exports are detected (`_chat.txt` or "WhatsApp Chat" in the name; iOS
`[5/11/26, 11:25:43 PM] Name: text` and Android `5/11/26, 23:25 - Name: text` formats; `<attached: file>` and
`file (file attached)` attachments map to the files in the zip). `.eml` files become an email item plus one item per
attachment. `__MACOSX` and dotfiles are dropped.

### ocr (`src/core/ocr/index.js`)
```js
ocrImage(bytes) -> { text, words: Word[], width, height }   // tesseract.js + bundled eng model, no network
terminateOcr()
```
`Word = { text, page, x0, y0, x1, y1, conf? }`.

### ai (`src/core/ai/index.js`)
```js
createAI({ mode: 'direct'|'proxy'|'off'|'mock', apiKey?, proxyUrl?, getAccessToken?, model?, fetch? }) -> AI
AI.available, AI.mode, AI.model
AI.classify(item, { textHint })            -> { docType, confidence, reason }
AI.extract(item, docType, { textHint, pageImages? }) -> Extraction
AI.readChat(chat)                          -> { relevant: [{at,author,text,why}], requests: [{text, ref}], packing: [{ref, lines: Line[]}], refs: string[] }
AI.readEmail(email)                        -> { relevant: [...], requests: [...], refs: string[] }
AI.route(text, { shipments, openQuestions }) -> { intent, shipmentRef, kinds, reply }
AI.draftPackingList({ shipment, chatLines, emails, documents }) -> { lines: Line[], sources: [{kind, ref, quote}], notes }
AI.usage()                                 -> { calls, inputTokens, outputTokens }   (sync)
```
`Extraction = { docType, summary, fields: Field[], lines: Line[], declarations: string[] }`,
`Field = { key, value, quote, page, confidence, box? }` (key from `FIELD_KEYS`), `Line = { lineNo, description,
reportNumber, lab, shape, carat, color, clarity, pieces, rate, amount, growth, quote }` (missing values are `null`).
Mode `off` (no key and no sign-in) uses the offline heuristic reader (`ai/heuristics.js`, regex over the text layer or OCR
text), so the app still works, less accurately. Mode `mock` takes a `mockHandler` for tests.
Proxy protocol: `POST {proxyUrl}` with `Authorization: Bearer <user JWT>`, body = an OpenAI Chat Completions request;
the response is the OpenAI response JSON.

### records (`src/core/records/*.js`)
```js
locate(words, quote, { page? })            -> { page, box: [x0,y0,x1,y1] } | null   (sync)
groupShipments({ documents, shipments, house }) -> { shipments: Shipment[], assignments: { [docId]: shipmentId } }  (sync)
matchStones({ shipment, documents })        -> { stones: Stone[], issues: [{ code, detail, ref, docIds }] }  (sync)
buildHistory({ stone, shipment, documents, papers }) -> HistoryEvent[]   (sync)
```

### rules (`src/core/rules/compliance.js`, `formats.js`)
```js
RULES_VERSION
classifyGoods({ documents, stones }) -> { nature: 'natural'|'lab-grown'|'mixed'|'unknown', form: 'rough'|'polished'|'jewelry'|'mixed'|'unknown', hsCodes, maxCarat, stonesAtOrAboveHalf }
evaluate({ shipment, documents, stones, house, screenings, now }) ->
  { checks: Check[], required: [{ kind, reason, signer, regime }], questions: QuestionDraft[], status, summary: { passed, total } }
```

### sanctions (`src/core/sanctions/index.js`)
```js
loadSdn({ cacheDir, fetch?, maxAgeHours = 24 }) -> SdnIndex { count, date, source, entries }
screen(name, index, { country? }) -> { name, status: 'clear'|'review'|'match', best: { sdnName, uid, programs, score } | null, compared }  (sync)
```

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
buildStatement({ kind: 'eu_dds'|'us_cbp_certificate'|'g7_gf_declaration', shipment, stones, house, status }) -> { bytes, sha256 }
buildPackingListDraft({ shipment, lines, sources, house }) -> { bytes, sha256 }
signPdf(bytes, { name, title, signedAt, signatureDataUrl? }) -> { bytes, sha256 }
TEMPLATES   // exact statement wording + official source URLs
```

### mail (`src/core/mail/index.js`)
```js
PROVIDERS                                           // gmail, outlook, icloud, yahoo, zoho, custom
connectMailbox({ provider, email, appPassword, host?, port? }) -> Mailbox
Mailbox.test() ; Mailbox.fetchSince(date, { domains? }) -> [{ uid, messageId, from, subject, date, eml }] ; Mailbox.close()
sendMail({ provider, email, appPassword, to, cc, subject, text, attachments }) -> { messageId }
```

### services (`src/core/services.js`)
```js
createServices({ store, ai, sanctionsLoader, ocr, labsVerify?, rasterize?, notify?, paths, deviceId, clock?, lease? }) -> Services
Services.events            // EventEmitter: 'agent', 'activity', 'change', 'notify'
Services.addFiles(files)   // [{ name, bytes, source }] -> { documentIds }
Services.run({ shipmentId?, reason })
Services.autopilot.get() / .set(on)
Services.ask(text, { shipmentId? }) -> { reply, actions }
Services.answerQuestion(id, answer, by)
Services.buildPapers(shipmentId, { kinds?, by })
Services.signPaper(paperId, { name, title, signatureDataUrl? }, by)
Services.sendPaper(paperId, { to, cc, subject, body }, by)
Services.desk.queue() / approve(paperId, message, by) / hold(paperId, message, by)
Services.history(reportNumber) -> { stone, shipment, events }
Services.metrics() -> { houses: [...], totals }
Services.mail.connect(opts) / status() / disconnect() / pollNow()
Services.folder.set(path) / status()
Services.worker.start() / stop() / status()
Services.loadSample() / resetSample()
```
`'agent'` events drive the live view: `{ agent, action: 'start'|'read'|'field'|'check'|'screen'|'question'|'paper'|'done'|'error',
docId?, shipmentId?, page?, key?, label?, value?, box?, message }`.

## Electron bridge (`window.jl`, defined in `src/main/preload.cjs`)

```
jl.app.info()                       jl.app.openExternal(url)          jl.app.showItem(path)
jl.app.qr(text) -> dataUrl          jl.app.checkUpdate() -> { latest, url } | null
jl.auth.status() .signIn() .signUp() .signOut()
jl.workspaces.list() .create(profile) .select(id) .current() .update(patch) .join(code) .invite(role) .members()
jl.docs.pick() .add(files) .list(q) .get(id) .file(id) .remove(id)
jl.shipments.list() .get(id) .update(id, patch)
jl.stones.list(q) .history(reportNumber) .verify(stoneId)
jl.questions.list(q) .answer(id, answer) .dismiss(id)
jl.papers.list(q) .build(shipmentId, kinds) .file(id) .open(id) .print(id) .sign(id, sig) .send(id, mail) .save(id)
jl.agents.run(q) .ask(text, q) .autopilot(on?)
jl.activity.list(q)   jl.messages.list(q) .send(msg)
jl.desk.queue() .approve(paperId, message) .hold(paperId, message) .houses() .onboard(profile)
jl.sanctions.status() .screen(name) .refresh()
jl.mail.connect(opts) .status() .disconnect() .pollNow()
jl.folder.choose() .status()
jl.settings.get() .set(patch)
jl.metrics.get()
jl.demo.load() .reset()
jl.on(event, fn) -> unsubscribe     // 'agent' | 'activity' | 'change' | 'notify' | 'auth' | 'sync'
```
Every call returns a Promise; errors come back as `{ error: message }` objects, never thrown across the bridge.
The renderer falls back to `src/renderer/demo/mock-api.js` when `window.jl` is missing (website demo).

## Security rules

- No API key ever ships in the app or the repo. The Jewel Labs key lives in Supabase (Edge Function secret).
  A house may paste its own OpenAI key in Settings; it is stored with Electron `safeStorage`.
- Row-level security: a user only reads workspaces they are a member of; desk users read all houses.
- Renderer runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; strict CSP.
- Mailbox app passwords are stored with `safeStorage`, never in plain JSON.
