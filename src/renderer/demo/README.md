# The browser demo

When the screens run without Electron (on the website, or in a test with a plain browser), there is no
`window.jl`. `api.js` then loads `demo/mock-api.js`, which answers every `window.jl` call the same way the
desktop app does, in memory, in this tab only. Nothing is uploaded, sent or saved anywhere.

The demo plays a run of the agents:

1. a **recorded run** from `demo/sample-run.json`, when that file has steps in it, or
2. the **built-in scripted run** from `demo/sample.js`: the fictional SAMPLE house Nilgiri Star Diamonds,
   whose WhatsApp export arrives with 7 papers for shipment NS/26-27/041 (Surat to Antwerp). The agents
   read every page (the papers are real PDFs drawn by `demo/mini-pdf.js`, the factory register is a phone
   photo drawn on a canvas), trace the 6 stones, screen the parties, run the rules and ask one question.
   Answer it and the papers are built, ready to sign.

The banner on top says which one is playing ("a recorded run" or "a scripted run").

## Files

| file | what it does |
|------|--------------|
| `mock-api.js` | `createMockApi()`: every `window.jl` method, plus `demo.status()`, `demo.skip()`, `checks.list()` and `parties.list()` |
| `sample.js` | the SAMPLE world (house, 4 shipments, stones, checks) and `buildScriptedRun()` |
| `sample-docs.js` | the sample papers as PDFs (invoice, packing list, shipping bill, air waybill, rough invoice) and the factory photo |
| `sample-papers.js` | the export pack and the EU / US statements the demo's Paperwork agent builds |
| `mini-pdf.js` | a tiny PDF writer (standard fonts, lines, boxes) that records where each field was printed |
| `qr.js` | a small QR code maker (byte mode, level M) for the WhatsApp QR in the demo |
| `sample-run.json` | the recorded run, or a stub with `"steps": []` |

## The recorded run format (`sample-run.json`)

```json
{
  "meta": { "format": 1, "title": "Recorded run on NS/26-27/041", "recorded": true, "createdAt": "2026-11-15T10:00:00Z", "durationMs": 61000 },
  "workspace": { "id": "ws-sample", "name": "Nilgiri Star Diamonds", "sample": true },
  "files": { "doc-a-inv": "files/doc-a-inv.pdf", "pap-a-exp:1:ready_to_sign": "files/JL-EXP-1115-01-v1.pdf" },
  "steps": [
    { "t": 0,    "kind": "put",    "name": "documents", "payload": { "id": "doc-a-inv", "fileName": "Invoice.pdf", "status": "new" } },
    { "t": 1200, "kind": "event",  "name": "agent",     "payload": { "agent": "intake", "action": "field", "docId": "doc-a-inv", "page": 1, "key": "invoice.number", "label": "Invoice number", "value": "NS/26-27/041", "box": [0.67, 0.07, 0.8, 0.09], "message": "Invoice number: NS/26-27/041" } },
    { "t": 1900, "kind": "event",  "name": "activity",  "payload": { "id": "act-1", "at": "...", "actor": { "type": "agent", "name": "Intake" }, "action": "read", "detail": "..." } },
    { "t": 2400, "kind": "remove", "name": "questions", "payload": { "id": "q-1" } }
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
- `files` maps a document id (and, optionally, `<paperId>:<version>:<status>` for papers) to a URL relative to
  `sample-run.json`, or a `data:` URL. Documents without a file show "This page could not be shown".
- `final` is optional: records to lay over the end state (for a visitor who comes back later). Without it the
  player works the end state out by applying every step.

`scripts/record-demo.js` writes this file from a real run of the desktop agents on the SAMPLE shipment
(record the services' `agent`, `activity`, `notify` and `change` events with their times, and copy the files).
Keep every record fictional and labelled SAMPLE.

## Useful addresses

- `index.html?autoplay=1#/home` skips the welcome screen and starts the run (for the website's live demo).
- `#/desk`, `#/stones/2211458730`, `#/papers` open those screens straight away.
