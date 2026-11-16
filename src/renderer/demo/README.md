# The browser demo

When the screens run without Electron (on the website, or in a test with a plain browser), there is no
`window.jl`. `api.js` then loads `demo/mock-api.js`, which answers every `window.jl` call the same way the
desktop app does, in memory, in this tab only. Nothing is uploaded, sent or saved anywhere.

The demo replays a **recorded run** of the real desktop agents, `demo/sample-run.json`, on the fictional SAMPLE
house Kavya Gems LLP (SAMPLE). Everything the demo shows comes from that recording: the house and its people, the
papers and their files, every step the agents took, the questions they asked and the papers they built. The recorded
times are moved so the run shows as happening now (paper dates stay as the papers say). When the file cannot be
loaded, the banner on top says so and the demo stays empty: there is no made-up stand-in.

What a visitor does on top of the recording happens in this tab only, and the demo never claims more than it did:

- **Answer** a question: the answer is saved and the question closes. The demo cannot run the rules again, so it
  says what the desktop app does next and keeps the shipment's recorded status.
- **Sign** a paper: the paper is marked signed and opens as the copy signed while the run was recorded (its
  signature reads "Demo signature (SAMPLE)"); a notice says so.
- **Send** a paper: it is marked sent; no email leaves the browser.
- **Verify** a stone, **run** the agents or **build** papers again: the demo says what the desktop app does instead
  of pretending (it never opens a lab's website, so it never reports a match).
- A question about papers that disagree, or a possible sanctions match, cannot be dismissed, as in the app.

## Files

| file | what it does |
|------|--------------|
| `mock-api.js` | `createMockApi()`: every `window.jl` method, plus `demo.status()` and `demo.skip()` |
| `qr.js` | a small QR code maker (byte mode, level M) for the WhatsApp QR in the demo |
| `sample-run.json` | the recorded run |
| `files/` | the recorded run's files: the originals, and each paper as built and as signed |

## The recorded run format (`sample-run.json`)

```json
{
  "meta": { "format": 1, "recorded": true, "title": "Recorded run on the SAMPLE shipments KG/26-27/041, 042 and 043", "createdAt": "2026-11-16T05:26:32.918Z", "durationMs": 83115 },
  "workspace": { "id": "ws-sample", "name": "Kavya Gems LLP (SAMPLE)", "sample": true },
  "files": { "doc_0mwitmgts0004bd0809": "files/doc_0mwitmgts0004bd0809.pdf", "pap_0mwitoqud004g0c3262:1:ready_to_sign": "files/JL-EXP-1116-01-v1.pdf" },
  "steps": [
    { "t": 164,   "kind": "put",    "name": "documents", "payload": { "id": "doc_0mwitmgts0004bd0809", "fileName": "00000008-Invoice KG-26-27-041.pdf", "status": "new" } },
    { "t": 6434,  "kind": "event",  "name": "agent",     "payload": { "agent": "intake", "action": "field", "docId": "doc_0mwitmgts0004bd0809", "page": 1, "key": "invoice.number", "label": "Invoice number", "value": "KG/26-27/041", "box": [0.7058, 0.1654, 0.7908, 0.1742], "message": "Invoice number: KG/26-27/041" } },
    { "t": 7824,  "kind": "event",  "name": "activity",  "payload": { "id": "act_0mwitmnal0029cd3f9e", "at": "...", "actor": { "type": "agent", "name": "Intake" }, "action": "read", "detail": "00000008-Invoice KG-26-27-041.pdf: Commercial invoice, 29 fields read" } },
    { "t": 77464, "kind": "remove", "name": "checks",    "payload": { "id": "chk_114daf4b95282785" } }
  ],
  "final": { "collections": { "shipments": [ ... ], "papers": [ ... ] } }
}
```

- `t` is milliseconds from the start of the run. Steps play in order at their time.
- `kind: "put"` upserts `payload` into the collection `name` (any of documents, shipments, stones, checks,
  questions, papers, parties, activity, messages, events) and fires the `change` event the app listens to.
- `kind: "remove"` removes `payload.id` from the collection `name`.
- `kind: "event"` fires a live event: `name` is `agent`, `activity` or `notify`, with the same payload the
  desktop app sends (`AgentEvent`, `Activity`, `{ title, body }`). Field boxes are page coordinates from 0 to 1,
  origin top-left.
- `files` maps a document id (and, optionally, `<paperId>:<version>:<status>` for papers, plus a
  `<paperId>:<version>:signed` copy made while recording) to a URL relative to `sample-run.json`, or a `data:` URL.
  A document's file keeps the document's own file name. Documents without a file show "This page could not be shown".
- `workspace` is the SAMPLE house the demo shows (name, city, letterhead); `members`, when present, lists its people
  (otherwise the people who acted in the recording are its customer logins).
- `final` is optional: records to lay over the end state (for a visitor who comes back later). Without it the
  player works the end state out by applying every step.

`scripts/record-run.js` writes this file (`--cache` reuses saved AI answers, `--verify` replays it) from a real run
of the desktop agents on the SAMPLE shipments: it records the services' `agent`, `activity`, `notify` and `change`
events with their times, and copies the files into `files/`. (`scripts/record-demo.js` is a different script: it
records a video of the desktop app.) Keep every record fictional and labelled SAMPLE.

## Useful addresses

- `index.html?autoplay=1#/home` skips the welcome screen and starts the run (for the website's live demo).
- `#/desk`, `#/stones/7391020001`, `#/papers` open those screens straight away. 7391020001 is the 1.02 ct stone on
  KG/26-27/041 in the recorded run; its history shows once the Records agent has traced it.
