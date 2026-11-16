// The in-browser stand-in for window.jl, so the app runs on the website and in tests without Electron.
// Same methods and answers as src/main/preload.cjs + ipc.js. It replays a recorded run of the real desktop
// agents on the fictional SAMPLE house (demo/sample-run.json, written by scripts/record-run.js): the house, its
// people, its papers and every step come from that recording. What a visitor does on top (answer, sign, send)
// happens in memory in this tab only: nothing is uploaded, sent or saved anywhere, and the demo never says the
// agents did something they did not do in the recording.
import { qrDataUrl } from './qr.js';
import { PAPER_KIND_LABELS } from '../lib/labels.js';
import { plural } from '../lib/format.js';

const COLLECTIONS = ['documents', 'shipments', 'stones', 'checks', 'questions', 'papers', 'parties', 'activity', 'messages', 'events'];
const SAMPLE_ID = 'ws-sample'; // the recorded SAMPLE house
const LOCAL = { id: 'ws-local', kind: 'local', sample: false, name: 'Local workspace', autopilot: true };
const MODEL = 'gpt-5.4-mini'; // the model the run was recorded with
const DEMO_ONLY = 'This demo runs in your browser only. Download the desktop app to do this for real.';
const NO_OFAC = 'The demo does not carry the OFAC list. The desktop app screens every name against all of it.';
const ANSWER_FIRST = 'Answer this question; the agents need to know which is right.';
const NOT_NEEDED = /^(not needed|not required|no need|n\/?a|none needed|not applicable)\.?$/i;
const IMPORTER_STATEMENTS = ['eu_dds', 'us_cbp_certificate'];
const ONLINE_CHECK_LABS = ['GIA', 'IGI', 'HRD', 'GCAL'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A deep copy (typed arrays such as file bytes survive it), so callers never change our records by accident.
const copy = (v) => (v === undefined ? v : structuredClone(v));

let counter = 0;
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${(++counter).toString(36)}`;

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Moves every timestamp of the recording by offset ms, so the run shows as happening now, not on the day it
 * was recorded. Only full timestamps inside [from, to] (the recording's own hour) move: paper dates
 * ("2026-07-14") and chat or email times from before the run stay exactly as the papers say.
 */
export function shiftTimes(value, offset, from, to) {
  if (typeof value === 'string') {
    if (!ISO_TIME.test(value)) return value;
    const t = Date.parse(value);
    return t >= from && t <= to ? new Date(t + offset).toISOString() : value;
  }
  if (Array.isArray(value)) return value.map((v) => shiftTimes(v, offset, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shiftTimes(v, offset, from, to)]));
  return value;
}

/** The recording's own time window: from its start to an hour later (the run takes a minute or two). */
function recordingWindow(run) {
  const start = Date.parse(run?.meta?.createdAt || '');
  if (!Number.isFinite(start)) return null;
  const from = start - 10 * 60000;
  const to = start + 60 * 60000;
  let end = start + (Number(run.meta.durationMs) || 0);
  for (const step of run.steps) {
    const at = Date.parse(step.payload?.at || step.payload?.updatedAt || '');
    if (at > end && at <= to) end = at;
  }
  return { start, end, from, to };
}

/**
 * options: run (a recorded run to play instead of loading demo/sample-run.json), fetchRun (load it; default true in
 * a browser), speed (1 = real time), autoStart (show the run's end state at once; default true).
 */
export function createMockApi({ run: givenRun = null, fetchRun = typeof window !== 'undefined', speed = 1, autoStart = true } = {}) {
  const listeners = new Map(); // event name -> Set of functions
  const workspaces = new Map([[LOCAL.id, { ...LOCAL, createdAt: new Date().toISOString() }]]);
  const data = new Map(); // workspace id -> { collection -> Map(id -> record) }
  const files = new Map(); // id -> { name, mime, bytes } | URL string from the recording
  const timers = new Set();
  const settings = { autopilot: true, notifications: true, launchAtLogin: false, userName: null, model: null, signerTitle: 'Director' };
  const you = { type: 'person', name: 'You (demo)' };
  let current = SAMPLE_ID;
  let run = null; // the recorded run, or null when it could not be loaded
  let window_ = null; // its time window (recordingWindow)
  let offset = 0; // how far its times are moved (shiftTimes)
  let playing = false;

  // ---------- storage and events ----------

  function tables(wsId = current) {
    if (!data.has(wsId)) data.set(wsId, Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()])));
    return data.get(wsId);
  }
  function emit(name, payload) {
    for (const fn of listeners.get(name) || []) {
      try { fn(copy(payload)); } catch (e) { console.error(e); }
    }
  }
  // recorded: a record from the recording keeps its own (moved) times.
  function put(collection, record, { wsId = current, silent = false, recorded = false } = {}) {
    const table = tables(wsId)[collection];
    const old = table.get(record.id);
    const at = new Date().toISOString();
    const updatedAt = recorded ? record.updatedAt || old?.updatedAt || at : at;
    const value = { ...(old || {}), ...record, workspaceId: wsId, createdAt: old?.createdAt || record.createdAt || at, updatedAt };
    table.set(value.id, value);
    if (!silent && wsId === current) emit('change', { collection, id: value.id, op: 'put', value });
    return value;
  }
  function remove(collection, id) {
    tables()[collection].delete(id);
    emit('change', { collection, id, op: 'remove' });
  }
  const all = (collection, wsId = current) => [...tables(wsId)[collection].values()];
  const get = (collection, id) => tables()[collection].get(id) || null;

  function list(collection, q = {}) {
    const { limit, search, ...filters } = q || {};
    const needle = typeof search === 'string' ? search.trim().toLowerCase() : '';
    const rows = all(collection).filter((r) => Object.entries(filters).every(([k, v]) => v === undefined || (Array.isArray(v) ? v.includes(r[k]) : r[k] === v))
      && (!needle || JSON.stringify(r).toLowerCase().includes(needle)));
    rows.sort((a, b) => String(b.at || b.createdAt || '').localeCompare(String(a.at || a.createdAt || '')));
    return copy(Number.isInteger(limit) && limit > 0 ? rows.slice(0, limit) : rows);
  }

  function log(actor, action, detail, extra = {}) {
    const entry = { id: newId('act'), at: new Date().toISOString(), actor, action, detail, shipmentId: extra.shipmentId ?? null, docId: extra.docId ?? null, paperId: extra.paperId ?? null };
    put('activity', entry);
    emit('activity', entry);
    return entry;
  }
  const agentEvent = (agent, action, message, extra = {}) => emit('agent', { agent, action, message, at: new Date().toISOString(), ...extra });
  const usage = (type, extra = {}) => put('events', { id: newId('evt'), type, at: new Date().toISOString(), userId: 'demo-visitor', ...extra }, { silent: true });

  // ---------- the recorded run ----------

  async function loadRun() {
    if (givenRun) return givenRun;
    if (!fetchRun) return null;
    try {
      const url = new URL('./sample-run.json', import.meta.url);
      const response = await fetch(url, { cache: 'no-cache' });
      const json = response.ok ? await response.json() : null;
      if (json && Array.isArray(json.steps) && json.steps.length) return { ...json, baseUrl: url.href };
    } catch {
      // no recording: the demo banner says so
    }
    return null;
  }

  // The recording's times moved by the current offset (a no-op without a recording window).
  const shift = (value) => (window_ ? shiftTimes(value, offset, window_.from, window_.to) : value);

  function stopTimers() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    playing = false;
  }

  function resetSample() {
    stopTimers();
    data.delete(SAMPLE_ID);
    files.clear();
    for (const [id, f] of Object.entries(run?.files || {})) files.set(id, f);
  }

  function applyStep(step, { live }) {
    const payload = shift(step.payload);
    if (step.kind === 'put') put(step.name, payload, { wsId: SAMPLE_ID, silent: !live || current !== SAMPLE_ID, recorded: true });
    else if (step.kind === 'remove') {
      tables(SAMPLE_ID)[step.name]?.delete(payload?.id);
      if (live && current === SAMPLE_ID) emit('change', { collection: step.name, id: payload?.id, op: 'remove' });
    } else if (step.kind === 'event' && live && current === SAMPLE_ID) emit(step.name, payload);
  }

  /** Applies the whole run at once (the state a returning visitor sees), as if it had just finished. */
  function applyInstant() {
    resetSample();
    if (!run) return;
    offset = window_ ? Date.now() - window_.end : 0;
    for (const step of run.steps) applyStep(step, { live: false });
    for (const [c, rows] of Object.entries(run.final?.collections || {})) for (const r of rows) put(c, shift(r), { wsId: SAMPLE_ID, silent: true, recorded: true });
  }

  /** Plays the run from now: steps at their recorded times (divided by speed). */
  function playLive() {
    resetSample();
    if (!run) return;
    offset = window_ ? Date.now() - window_.start : 0;
    playing = true;
    let last = 0;
    for (const step of run.steps) {
      last = Math.max(last, step.t || 0);
      const timer = setTimeout(() => { timers.delete(timer); applyStep(step, { live: true }); }, (step.t || 0) / speed);
      timers.add(timer);
    }
    const done = setTimeout(() => { timers.delete(done); playing = false; }, last / speed + 50);
    timers.add(done);
  }

  const ready = (async () => {
    run = await loadRun();
    window_ = run ? recordingWindow(run) : null;
    // The SAMPLE house is the recording's own (name, city, letterhead): nothing else is mixed in.
    const house = run?.workspace ? { ...run.workspace } : { name: 'Sample workspace' };
    workspaces.set(SAMPLE_ID, { ...house, id: SAMPLE_ID, kind: 'local', sample: true, autopilot: true, createdAt: new Date(Date.now() - 90 * 864e5).toISOString() });
    if (autoStart) applyInstant();
    else resetSample();
  })();

  // ---------- files: originals and papers ----------

  // A file of the recording: fetched once from its URL (next to sample-run.json), named as its document is.
  async function fileOf(id) {
    let f = files.get(id);
    if (typeof f === 'string') {
      const response = await fetch(new URL(f, run?.baseUrl || import.meta.url));
      if (!response.ok) throw new Error('That file is not in this demo.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const doc = tables(SAMPLE_ID).documents.get(id);
      f = { name: doc?.fileName || f.split('/').pop(), mime: doc?.mime || response.headers.get('content-type') || '', bytes };
      files.set(id, f);
    }
    return f || null;
  }

  // The recording keeps each paper as "<paperId>:<version>:<status>", plus a copy signed while it was recorded.
  async function paperBytes(paper) {
    const signed = paper.status === 'signed' || paper.status === 'sent';
    for (const status of new Set([paper.status, signed ? 'signed' : null, 'ready_to_sign'].filter(Boolean))) {
      const f = await fileOf(`${paper.id}:${paper.version}:${status}`);
      if (f) return f;
    }
    throw new Error('This paper has no file in the demo.');
  }

  /** The refs of the shipments the recording has papers for ("KG/26-27/041"). */
  function shipmentsWithPapers() {
    const ids = new Set(all('papers', SAMPLE_ID).map((p) => p.shipmentId));
    return all('shipments', SAMPLE_ID).filter((s) => ids.has(s.id)).map((s) => s.ref);
  }

  /**
   * The agents build papers in the desktop app; the demo only has the ones the recording built. Asking for
   * them again returns those, unchanged. A shipment the recording built nothing for says so.
   */
  function buildPapers(shipmentId) {
    const shipment = get('shipments', shipmentId);
    if (!shipment) throw new Error('That shipment is not here.');
    const papers = all('papers').filter((p) => p.shipmentId === shipmentId);
    if (!papers.length) {
      const others = shipmentsWithPapers();
      throw new Error(`In the desktop app the Paperwork agent builds the papers for ${shipment.ref} once nothing is open. This recording has papers for ${others.length ? others.join(', ') : 'no shipment'} only.`);
    }
    agentEvent('paperwork', 'done', `${papers.map((p) => p.ref).join(' and ')}: as the agents built them in the recording`, { shipmentId });
    return copy(papers);
  }

  // ---------- answers ----------

  // The agents run the rules again after an answer. The demo cannot run them, so it says what happens next and
  // changes nothing it cannot know: the shipment keeps the status the recording gave it.
  async function afterAnswer(question) {
    const shipment = get('shipments', question.shipmentId);
    if (!shipment) return;
    await sleep(600 / speed);
    agentEvent('origin', 'check', `Checking ${shipment.ref} again with your answer`, { shipmentId: shipment.id });
    await sleep(700 / speed);
    const open = all('questions').filter((q) => q.shipmentId === shipment.id && q.status === 'open').length;
    if (open) {
      agentEvent('review', 'done', `${shipment.ref}: ${plural(open, 'question')} still open`, { shipmentId: shipment.id });
      return;
    }
    agentEvent('review', 'done', `${shipment.ref}: nothing open`, { shipmentId: shipment.id });
    emit('notify', {
      title: `${shipment.ref}: your answers are saved`,
      body: 'In the desktop app the agents now run the rules again and, when every check holds, build the papers. This demo replays a recording, so it stops here.',
      kind: 'demo',
      shipmentId: shipment.id,
    });
  }

  // ---------- a stone's history ----------

  // The recorded history, with the signing and sending a visitor did in this tab added (src/core/records/history.js
  // writes the same lines). An importer's statement drafted by the house is checked by the house, not signed.
  function stoneHistory(stone) {
    const events = (stone.history || []).filter((e) => e.kind !== 'statement_signed' && e.kind !== 'statement_sent');
    const shipment = get('shipments', stone.shipmentId);
    for (const paper of all('papers').filter((p) => p.shipmentId === stone.shipmentId && p.kind !== 'packing_list_draft')) {
      const label = (PAPER_KIND_LABELS[paper.kind] || 'Paper').replace(' (draft)', '');
      const forImporter = IMPORTER_STATEMENTS.includes(paper.kind) && shipment?.direction !== 'import';
      if (paper.signedAt) {
        events.push(forImporter
          ? { at: paper.signedAt, kind: 'statement_signed', title: `${label} checked by the house`, detail: `${paper.ref} prepared and checked by ${paper.signedBy}.`, docId: null, field: null }
          : { at: paper.signedAt, kind: 'statement_signed', title: `${label} signed`, detail: `${paper.ref} signed by ${paper.signedBy}.`, docId: null, field: null });
      }
      if (paper.sentAt) {
        events.push({ at: paper.sentAt, kind: 'statement_sent', title: forImporter ? `${label} sent to the importer` : `${label} sent`, detail: `${paper.ref} sent to ${paper.sentTo}.`, docId: null, field: null });
      }
    }
    return events;
  }

  // ---------- reading files someone adds in the demo ----------

  function guessType(name) {
    const n = name.toLowerCase();
    if (/invoice|inv[\s_-]/.test(n)) return 'commercial_invoice';
    if (/pack/.test(n)) return 'packing_list';
    if (/awb|waybill|hawb|mawb/.test(n)) return 'air_waybill';
    if (/shipping|\bsb\b|leo/.test(n)) return 'shipping_bill';
    if (/kp|kimberley/.test(n)) return 'kp_certificate';
    if (/gia|igi|hrd|report|cert/.test(n)) return 'lab_report';
    if (/whatsapp|chat/.test(n)) return 'whatsapp_chat';
    if (/\.eml$/.test(n)) return 'email';
    return 'other';
  }

  // A small offline reader for PDFs dropped into the demo: text positions from pdf.js, a few patterns.
  async function readPdfFields(bytes) {
    try {
      const pdfjs = await import('../vendor/pdfjs/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
      const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href }).promise;
      const fields = [];
      const patterns = [
        ['invoice.number', /(?:invoice|inv)\.?\s*(?:no|number|#)?\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9/-]{3,})/i],
        ['doc.date', /\b(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})\b/],
        ['goods.totalCarats', /\b(\d{1,4}\.\d{2,3})\s*(?:ct|cts|carats?)\b/i],
        ['lab.reportNumber', /\b(\d{9,10})\b/],
        ['goods.hsCode', /\b(710[2-4]\.?\d{2,4})\b/],
      ];
      for (let n = 1; n <= Math.min(doc.numPages, 3); n++) {
        const page = await doc.getPage(n);
        const view = page.getViewport({ scale: 1 });
        const { items } = await page.getTextContent();
        for (const item of items) {
          for (const [key, re] of patterns) {
            if (fields.some((f) => f.key === key)) continue;
            const m = re.exec(item.str || '');
            if (!m) continue;
            const [, , , , x, y] = item.transform;
            const h = item.height || 10;
            fields.push({ key, value: m[1], quote: item.str, page: n, confidence: 0.6, agent: 'intake',
              box: [x / view.width, (view.height - y - h) / view.height, (x + item.width) / view.width, (view.height - y + h * 0.25) / view.height] });
          }
        }
      }
      await doc.loadingTask.destroy();
      return fields;
    } catch {
      return [];
    }
  }

  async function addFiles(fileList) {
    const ids = [];
    for (const item of Array.from(fileList || [])) {
      const name = item.name || 'file';
      const bytes = item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(await item.arrayBuffer());
      const mime = item.type || (/\.pdf$/i.test(name) ? 'application/pdf' : /\.(png|jpe?g)$/i.test(name) ? 'image/png' : 'application/octet-stream');
      const id = newId('doc');
      files.set(id, { name, mime, bytes });
      const kind = /pdf/.test(mime) ? 'pdf' : /^image\//.test(mime) ? 'image' : /zip/.test(mime) ? 'chat' : 'other';
      put('documents', { id, fileName: name, mime, kind, size: bytes.length, sha256: await sha256Hex(bytes), source: { kind: 'upload', receivedAt: new Date().toISOString() },
        pages: 1, docType: 'other', classifyConfidence: 0, fields: [], lines: [], declarations: [], shipmentId: null, status: 'new' });
      log({ type: 'agent', name: 'Retrieval' }, 'received', `${name} from an upload`, { docId: id });
      usage('upload', { docId: id });
      ids.push(id);
    }
    // Read them one by one, like the Intake agent (the demo reads PDFs with a few patterns, offline).
    (async () => {
      for (const id of ids) {
        const doc = get('documents', id);
        put('documents', { ...doc, status: 'reading' });
        agentEvent('intake', 'start', `Reading ${doc.fileName}`, { docId: id });
        await sleep(600 / speed);
        agentEvent('intake', 'read', `${doc.fileName}`, { docId: id });
        const f = files.get(id);
        const fields = doc.kind === 'pdf' ? await readPdfFields(f.bytes) : [];
        for (const field of fields) {
          agentEvent('intake', 'field', `${field.key}: ${field.value}`, { docId: id, page: field.page, key: field.key, label: field.key, value: field.value, box: field.box });
          await sleep(500 / speed);
        }
        const docType = guessType(doc.fileName);
        put('documents', { ...get('documents', id), status: 'read', docType, classifyConfidence: docType === 'other' ? 0.4 : 0.7, fields, readBy: 'Demo reader (offline)', readAt: new Date().toISOString(),
          summary: 'Read in the demo with a few patterns. The desktop app reads every field with the AI model and OCR.' });
        log({ type: 'agent', name: 'Intake' }, 'read', `${doc.fileName}: ${fields.length} fields read by the demo reader`, { docId: id });
      }
      if (ids.length) {
        agentEvent('review', 'done', 'The demo keeps your files in this tab only. The desktop app files them under a shipment.', {});
      }
    })();
    return { documentIds: ids };
  }

  // ---------- "Tell the agents" ----------

  // Answers from what is in the demo: what is missing, where each shipment stands, which papers exist.
  // Anything that needs the agents to work says it happens in the desktop app.
  async function ask(text, { shipmentId } = {}) {
    const request = String(text || '').trim();
    if (!request) throw new Error('Type a request for the agents.');
    const at = () => new Date().toISOString();
    put('messages', { id: newId('msg'), at: at(), from: 'house', author: you.name, text: request, shipmentId: shipmentId || null });
    log(you, 'asked', `Asked the agents: ${request}`, { shipmentId });
    const shipments = all('shipments');
    const byRef = shipments.find((s) => request.toUpperCase().replace(/[^0-9A-Z]/g, '').includes(s.ref.replace(/[^0-9A-Z]/g, '')));
    const open = shipments.filter((s) => !['signed', 'sent'].includes(s.status)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const shipment = (shipmentId && get('shipments', shipmentId)) || byRef || open[0] || null;
    const steps = ['Sending your request'];
    let reply;
    let actions = [];
    await sleep(500 / speed);
    if (/missing|still need|what.*need/i.test(request)) {
      steps.push('Checking the documents');
      agentEvent('review', 'check', 'Looking for what is still missing', {});
      await sleep(900 / speed);
      const parts = [];
      for (const s of open) {
        const qs = all('questions').filter((q) => q.shipmentId === s.id && q.status === 'open');
        parts.push(qs.length ? `${s.ref}: ${qs.map((q) => (q.kind === 'missing_document' ? q.text.replace(/ for .*/, '') : q.text)).join('; ')}.` : `${s.ref}: nothing is missing.`);
        actions.push(...qs.map((q) => ({ kind: 'question', questionId: q.id, text: q.text })));
      }
      reply = parts.join('\n') || 'Nothing is missing on any open shipment.';
    } else if (/prepare|build|paper|statement|pack|export/i.test(request)) {
      if (!shipment) reply = 'There is no shipment yet. Add its papers and the agents will start.';
      else {
        steps.push('Matching your documents', 'Checking the documents');
        agentEvent('records', 'done', `${plural(all('documents').filter((d) => d.shipmentId === shipment.id).length, 'document')} on file for ${shipment.ref}`, { shipmentId: shipment.id });
        await sleep(800 / speed);
        const qs = all('questions').filter((q) => q.shipmentId === shipment.id && q.status === 'open');
        const papers = all('papers').filter((p) => p.shipmentId === shipment.id);
        if (qs.length) {
          reply = `${shipment.ref} has ${qs.length === 1 ? 'one open question' : `${qs.length} open questions`} first: ${qs.map((q) => q.text).join(' ')}`;
          actions = qs.map((q) => ({ kind: 'question', questionId: q.id, text: q.text }));
        } else if (papers.length) {
          reply = papers.map((p) => `${PAPER_KIND_LABELS[p.kind] || p.kind} ${p.ref} v${p.version}: ${String(p.status).replace(/_/g, ' ')}.`).join('\n');
          actions = papers.map((p) => ({ kind: 'paper', paperId: p.id, ref: p.ref, status: p.status }));
        } else {
          reply = `In the desktop app the Paperwork agent builds the papers for ${shipment.ref} now. This demo replays a recording, which has no papers for it.`;
        }
      }
    } else if (/status|where|how.*going/i.test(request)) {
      reply = open.map((s) => `${s.ref}: ${s.status.replace(/_/g, ' ')}.`).join('\n') || 'Every shipment is signed or sent.';
    } else {
      reply = 'I can tell you what is still missing, where each shipment stands, or show the papers for a shipment. In the desktop app the agents answer anything with the AI model; this demo knows those three requests.';
    }
    const answer = { reply, actions, steps, intent: 'demo', shipmentId: shipment?.id || null };
    put('messages', { id: newId('msg'), at: at(), from: 'agents', text: reply, steps, actions, intent: 'demo', shipmentId: shipment?.id || null });
    return answer;
  }

  // ---------- the API (same names as window.jl) ----------

  const ok = (fn) => async (...args) => {
    await ready;
    try {
      return copy(await fn(...args));
    } catch (e) {
      return { error: e?.message || String(e) };
    }
  };
  const info = () => ({
    name: 'Jewel Labs', version: '1.0.0', platform: 'web', arch: '', isDev: false, demo: true, ready: true, error: null, mode: 'local',
    workspaceId: current, sample: current === SAMPLE_ID, cloud: false, signedIn: false, role: 'owner', deskAllowed: true, canApprove: false,
    ai: { mode: 'demo', model: MODEL, available: true }, autopilot: settings.autopilot, secureStorage: false, site: null, repo: null,
  });
  // A visitor may look at the desk, but approving a held pack needs a real Jewel Labs desk account.
  const auth = () => ({ cloud: false, signedIn: false, user: null, role: 'owner', deskAllowed: true, canApprove: false });
  const workspaceOut = (w) => ({ ...w, kind: 'local', sample: w.id === SAMPLE_ID, role: 'owner' });
  const select = (id) => {
    if (!workspaces.has(id)) throw new Error('That workspace was not found.');
    current = id;
    emit('sync', { reason: 'opened', workspaceId: id, kind: 'local' });
    return workspaceOut(workspaces.get(id));
  };
  // The parties the recording screened keep their recorded result. Any other name was never screened here.
  const screenName = (name) => {
    const known = all('parties', SAMPLE_ID).find((p) => String(p.name).toLowerCase() === String(name).toLowerCase());
    if (known) return { name, status: known.status, best: known.best || null, compared: known.compared ?? 0, listDate: known.listDate || null };
    return { name, status: 'review', best: null, compared: 0, note: NO_OFAC };
  };
  // The list the recording screened against (from its parties, so it shows from the first second of a replay).
  const ofac = () => {
    const party = (run?.steps || []).map((s) => (s.name === 'parties' ? s.payload : null)).find((p) => p?.listCount);
    return party
      ? { count: party.listCount, date: party.listDate, source: 'The OFAC SDN list as recorded with the run. The desktop app refreshes it every day.' }
      : { count: 0, date: null, source: NO_OFAC };
  };
  // The people of the recorded house: everyone who acted in the recording, plus the visitor.
  const members = () => {
    const people = run?.members || [...new Set(all('activity', SAMPLE_ID).filter((a) => a.actor?.type === 'person' && a.actor.name !== you.name).map((a) => a.actor.name))]
      .map((name) => ({ id: `person-${name}`, name, email: null, role: 'preparer' }));
    return [{ name: you.name, email: null, role: 'owner', you: true }, ...(current === SAMPLE_ID ? people : [])];
  };

  const api = {
    app: {
      info: ok(info),
      openExternal: ok((url) => { if (!/^https:\/\//.test(String(url))) throw new Error('Only https links can be opened.'); window.open(url, '_blank', 'noopener'); return true; }),
      showItem: ok(() => { throw new Error(DEMO_ONLY); }),
      qr: ok((text) => qrDataUrl(String(text))),
      checkUpdate: ok(() => null),
    },
    auth: {
      status: ok(auth),
      signIn: ok(() => { throw new Error(`Accounts work in the desktop app. ${DEMO_ONLY}`); }),
      signUp: ok(() => { throw new Error(`Accounts work in the desktop app. ${DEMO_ONLY}`); }),
      signOut: ok(auth),
    },
    workspaces: {
      list: ok(() => [...workspaces.values()].map(workspaceOut)),
      create: ok((profile) => { const w = { id: newId('ws'), name: profile.name, autopilot: true, createdAt: new Date().toISOString() }; workspaces.set(w.id, w); return select(w.id); }),
      select: ok(select),
      current: ok(() => workspaceOut(workspaces.get(current))),
      update: ok((patch) => { const next = { ...workspaces.get(current), ...patch, id: current, updatedAt: new Date().toISOString() }; workspaces.set(current, next); return workspaceOut(next); }),
      join: ok(() => { throw new Error(`Invite codes work in the desktop app. ${DEMO_ONLY}`); }),
      invite: ok(() => { throw new Error(`Invites work for shared workspaces in the desktop app. ${DEMO_ONLY}`); }),
      revoke: ok(() => { throw new Error(`Invites work for shared workspaces in the desktop app. ${DEMO_ONLY}`); }),
      members: ok(members),
    },
    docs: {
      pick: ok(() => ({ canceled: true, documentIds: [] })),
      add: async (fileList) => { await ready; try { return await addFiles(fileList); } catch (e) { return { error: e.message }; } },
      list: ok((q) => list('documents', q)),
      get: ok((id) => get('documents', id)),
      file: ok(async (id) => {
        const f = await fileOf(id);
        if (!f) throw new Error('That file is not in this demo.');
        return { name: f.name, mime: f.mime, bytes: f.bytes };
      }),
      remove: ok((id) => { const doc = get('documents', id); remove('documents', id); log(you, 'document.remove', `Removed ${doc?.fileName || 'a document'}`); return true; }),
    },
    shipments: {
      list: ok((q) => list('shipments', q)),
      get: ok((id) => get('shipments', id)),
      update: ok((id, patch) => { const s = get('shipments', id); if (!s) throw new Error('That shipment was not found.'); usage('house_edit', { shipmentId: id }); return put('shipments', { ...s, ...patch, id }); }),
    },
    stones: {
      list: ok((q) => list('stones', q)),
      history: ok((reportNumber) => {
        const key = String(reportNumber || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
        const stone = all('stones').find((s) => String(s.reportNumber || '').toUpperCase().replace(/[^0-9A-Z]/g, '') === key || s.id === reportNumber);
        if (!stone) return { stone: null, shipment: null, events: [] };
        return { stone, shipment: get('shipments', stone.shipmentId), events: stoneHistory(stone) };
      }),
      // The demo never opens a lab's website, so it never says a report matched.
      verify: ok((stoneId) => {
        const stone = get('stones', stoneId);
        if (!stone) throw new Error('That stone is no longer there.');
        const online = ONLINE_CHECK_LABS.includes(String(stone.lab || '').toUpperCase());
        const reason = online ? 'The demo does not open lab websites. The desktop app opens the lab’s own report check.' : `${stone.lab || 'The lab'} has no online report check.`;
        const labCheck = { status: 'unavailable', diffs: [], reason, lab: stone.lab || null, checkedAt: new Date().toISOString(), checkedBy: you.name };
        put('stones', { ...stone, labCheck });
        log(you, 'lab check', `${stone.lab || 'Lab'} report ${stone.reportNumber} could not be checked: ${reason}`, { shipmentId: stone.shipmentId });
        return labCheck;
      }),
    },
    questions: {
      list: ok((q) => list('questions', q)),
      answer: ok((id, answer) => {
        const q = get('questions', id);
        if (!q) throw new Error('That question is no longer there.');
        if (q.status !== 'open') throw new Error('That question is already closed.');
        const text = String(answer ?? '').trim();
        if (!text) throw new Error('Type an answer first.');
        const notNeeded = q.kind === 'missing_document' && NOT_NEEDED.test(text);
        const saved = put('questions', { ...q, status: 'answered', answer: notNeeded ? 'Not needed' : text, notNeeded, answeredBy: you.name, answeredAt: new Date().toISOString() });
        const shipment = q.shipmentId ? get('shipments', q.shipmentId) : null;
        if (shipment && notNeeded && q.docType) put('shipments', { ...shipment, notNeeded: [...new Set([...(shipment.notNeeded || []), q.docType])] });
        usage('question_answered', { shipmentId: q.shipmentId });
        log(you, 'answered', `${q.text} ${notNeeded ? 'Not needed.' : `Answer: ${text}`}`, { shipmentId: q.shipmentId });
        if (shipment) afterAnswer(q);
        return { question: saved, shipment: q.shipmentId ? get('shipments', q.shipmentId) : null, status: shipment?.status || null };
      }),
      dismiss: ok((id) => {
        const q = get('questions', id);
        if (!q) throw new Error('That question is no longer there.');
        if (q.kind === 'mismatch' || q.kind === 'confirm') throw new Error(ANSWER_FIRST);
        log(you, 'question.dismiss', `Dismissed: ${q.text}`, { shipmentId: q.shipmentId });
        return put('questions', { ...q, status: 'dismissed', closedBy: you.name, closedAt: new Date().toISOString() });
      }),
    },
    papers: {
      list: ok((q) => list('papers', q)),
      build: ok((shipmentId) => buildPapers(shipmentId)),
      file: ok(async (id) => { const p = get('papers', id); if (!p) throw new Error('That paper was not found.'); const f = await paperBytes(p); return { name: f.name, mime: f.mime, bytes: f.bytes }; }),
      open: ok(async (id) => { const p = get('papers', id); const f = await paperBytes(p); window.open(URL.createObjectURL(new Blob([f.bytes], { type: 'application/pdf' })), '_blank', 'noopener'); return { path: f.name }; }),
      print: ok(async (id) => { const p = get('papers', id); const f = await paperBytes(p); window.open(URL.createObjectURL(new Blob([f.bytes], { type: 'application/pdf' })), '_blank', 'noopener'); return { printed: false, opened: f.name, reason: 'The demo opens the PDF in a new tab; print it from there.' }; }),
      sign: ok(async (id, sig) => {
        const paper = get('papers', id);
        if (!paper) throw new Error('That paper is no longer there.');
        if (paper.status === 'held_for_review') throw new Error('This pack is held for review. It can be signed once Jewel Labs approves it.');
        if (paper.status === 'signed' || paper.status === 'sent') throw new Error('This paper is already signed.');
        if (!String(sig?.name || '').trim()) throw new Error('Type the name of the person signing.');
        const signedAt = new Date().toISOString();
        const next = { ...paper, status: 'signed', signedBy: String(sig.name).trim(), signerTitle: sig.title || null, signedAt };
        const f = await paperBytes(next);
        next.sha256 = await sha256Hex(f.bytes);
        next.versions = [...(paper.versions || []), { version: paper.version, builtAt: signedAt, status: 'signed' }];
        const saved = put('papers', next);
        const waiting = all('papers').filter((p) => p.shipmentId === paper.shipmentId && !['signed', 'sent'].includes(p.status));
        if (!waiting.length) put('shipments', { ...get('shipments', paper.shipmentId), status: 'signed' });
        usage('pack_signed', { paperId: id, shipmentId: paper.shipmentId });
        log({ type: 'person', name: next.signedBy }, 'signed', `Signed ${paper.ref} v${paper.version}`, { shipmentId: paper.shipmentId, paperId: id });
        emit('notify', { title: 'The demo PDF carries the recorded signature', body: 'It was signed while the run was recorded (Demo signature, SAMPLE). The desktop app puts your own name, title and signature on the paper.', kind: 'demo' });
        return saved;
      }),
      // Sending is marked in this tab only: no email leaves the browser.
      send: ok((id, mail) => {
        const paper = get('papers', id);
        if (!paper) throw new Error('That paper is no longer there.');
        if (paper.status !== 'signed' && paper.status !== 'sent') throw new Error('Sign the paper first.');
        const to = String(mail?.to || '').split(/[,;]/).map((a) => a.trim()).filter(Boolean);
        if (!to.length || !to.every((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a))) throw new Error('Add who it goes to, as email addresses.');
        const saved = put('papers', { ...paper, status: 'sent', sentTo: to.join(', '), sentCc: mail.cc || null, sentAt: new Date().toISOString() });
        const unsent = all('papers').filter((p) => p.shipmentId === paper.shipmentId && p.status !== 'sent');
        if (!unsent.length) put('shipments', { ...get('shipments', paper.shipmentId), status: 'sent' });
        usage('pack_sent', { paperId: id, shipmentId: paper.shipmentId });
        log(you, 'sent', `Marked ${paper.ref} v${paper.version} as sent to ${to.join(', ')} (demo: no email left this tab)`, { shipmentId: paper.shipmentId, paperId: id });
        return saved;
      }),
      save: ok(() => ({ canceled: true })),
    },
    agents: {
      run: ok(({ shipmentId } = {}) => {
        const s = shipmentId ? get('shipments', shipmentId) : null;
        const what = s ? s.ref : 'every open shipment';
        agentEvent('records', 'done', `In the desktop app the agents now run again on ${what}. This demo replays a recording, so nothing changes here.`, { shipmentId });
        log({ type: 'system', name: 'Demo' }, 'run', `Asked the agents to run on ${what} (the demo replays a recording)`, { shipmentId });
        return { ran: false, demo: true };
      }),
      ask: ok(ask),
      autopilot: ok((on) => { if (typeof on === 'boolean') { settings.autopilot = on; emit('sync', { reason: 'autopilot', autopilot: on }); } return settings.autopilot; }),
    },
    activity: { list: ok((q) => list('activity', q)) },
    messages: {
      list: ok((q) => list('messages', q)),
      send: ok((msg) => put('messages', { id: newId('msg'), at: new Date().toISOString(), from: msg.to === 'house' ? 'desk' : 'house', author: you.name, text: msg.text, shipmentId: msg.shipmentId || null })),
    },
    desk: {
      queue: ok(() => all('papers').filter((p) => p.status === 'held_for_review').map((paper) => ({
        paper, shipment: get('shipments', paper.shipmentId),
        checks: all('checks').filter((c) => c.shipmentId === paper.shipmentId && c.severity !== 'pass'),
        questions: all('questions').filter((q) => q.shipmentId === paper.shipmentId && q.status === 'open'),
      }))),
      approve: ok(() => { throw new Error(`Only a signed-in Jewel Labs desk account can approve a held pack. ${DEMO_ONLY}`); }),
      hold: ok((paperId, message) => {
        const paper = get('papers', paperId);
        if (!paper) throw new Error('That paper is no longer there.');
        const text = message || `${paper.ref} is held for review.`;
        const saved = put('papers', { ...paper, status: 'held_for_review', deskNote: text, heldBy: you.name, heldAt: new Date().toISOString() });
        put('messages', { id: newId('msg'), at: new Date().toISOString(), from: 'desk', to: 'house', kind: 'desk', author: you.name, text, shipmentId: paper.shipmentId, paperId });
        log(you, 'held', `Held ${paper.ref} v${paper.version}: ${text}`, { shipmentId: paper.shipmentId, paperId });
        return saved;
      }),
      houses: ok(() => [...workspaces.values()].map(workspaceOut)),
      // Like the desktop app, the new house opens at once, so what follows (records, chat export) goes to it.
      onboard: ok((profile) => {
        const w = { id: newId('ws'), name: profile.name, legalEntity: profile.legalEntity || null, country: profile.country || null, city: profile.city || null, autopilot: profile.autopilot !== false, createdAt: new Date().toISOString() };
        workspaces.set(w.id, w);
        const screening = screenName(profile.legalEntity || profile.name);
        select(w.id);
        return { workspace: workspaceOut(w), screening, invite: { error: `Portal logins are created in the desktop app. ${DEMO_ONLY}` }, opened: true, openError: null };
      }),
    },
    sanctions: { status: ok(ofac), screen: ok(screenName), refresh: ok(ofac) },
    mail: {
      connect: ok(() => { throw new Error(`Mailboxes connect in the desktop app. ${DEMO_ONLY}`); }),
      status: ok(() => ({ connected: false, provider: null, email: null, lastPollAt: null, nextPollAt: null, lastError: null, pulled: 0, needsPassword: false })),
      disconnect: ok(() => ({ connected: false })),
      pollNow: ok(() => { throw new Error('Connect a mailbox first.'); }),
    },
    folder: {
      choose: ok(() => { throw new Error(`Folders are watched by the desktop app. ${DEMO_ONLY}`); }),
      status: ok(() => ({ path: null, watching: false, lastScanAt: null, files: 0, lastError: null })),
    },
    settings: {
      get: ok(() => ({ ...settings, models: ['gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1-mini'], hasOpenAIKey: false, secureStorage: false, aiMode: 'demo', folder: null, mailbox: null })),
      set: ok((patch = {}) => {
        if (patch.openaiKey) throw new Error('The demo never takes an API key. Keys are saved, encrypted, in the desktop app only.');
        for (const k of ['autopilot', 'notifications', 'launchAtLogin', 'userName', 'model', 'signerTitle']) if (patch[k] !== undefined) settings[k] = patch[k];
        if (patch.autopilot !== undefined) emit('sync', { reason: 'autopilot', autopilot: settings.autopilot });
        return { ...settings, models: ['gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1-mini'], hasOpenAIKey: false, secureStorage: false, aiMode: 'demo' };
      }),
    },
    metrics: { get: ok(() => metrics()) },
    demo: {
      load: ok(() => {
        if (!run) throw new Error('The recorded run of the agents could not be loaded. Reload the page.');
        current = SAMPLE_ID;
        playLive();
        emit('sync', { reason: 'opened', workspaceId: SAMPLE_ID, kind: 'local' });
        return { started: true, recorded: true };
      }),
      reset: ok(() => { resetSample(); emit('sync', { reason: 'opened', workspaceId: SAMPLE_ID, kind: 'local' }); return true; }),
      status: ok(() => ({ recorded: Boolean(run), playing, title: run?.meta?.title || null })),
      skip: ok(() => { applyInstant(); emit('sync', { reason: 'opened', workspaceId: SAMPLE_ID, kind: 'local' }); return true; }),
    },
    checks: { list: ok((q) => list('checks', q)) },
    parties: { list: ok((q) => list('parties', q)) },
    on(event, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    /** For tests: wait until the run is loaded. */
    ready: () => ready,
  };

  // Usage numbers from what happened in this tab and in the recording. The SAMPLE house is a sandbox: it gets a
  // row but stays out of the totals, like on the real desk.
  function metrics() {
    const weekAgo = Date.now() - 7 * 864e5;
    const houses = [...workspaces.values()].map((w) => {
      const papers = all('papers', w.id);
      const events = all('events', w.id);
      const signed = papers.filter((p) => p.signedAt);
      const minutes = signed.map((p) => {
        const docs = all('documents', w.id).filter((d) => d.shipmentId === p.shipmentId);
        const first = Math.min(...docs.map((d) => Date.parse(d.createdAt)));
        return Number.isFinite(first) ? Math.max(1, Math.round((Date.parse(p.signedAt) - first) / 60000)) : null;
      }).filter((n) => n !== null).sort((a, b) => a - b);
      const median = minutes.length ? (minutes.length % 2 ? minutes[(minutes.length - 1) / 2] : Math.round((minutes[minutes.length / 2 - 1] + minutes[minutes.length / 2]) / 2)) : null;
      const recent = events.filter((e) => Date.parse(e.at) > weekAgo);
      const sandbox = w.id === SAMPLE_ID;
      return {
        id: w.id, name: w.name, environment: sandbox ? 'sandbox' : 'live', inTotals: !sandbox,
        liveShipments: all('shipments', w.id).filter((s) => s.status !== 'sent').length,
        signInsLast7d: recent.filter((e) => e.type === 'sign_in').length,
        activeUsers7d: new Set(recent.map((e) => e.userId || e.deviceId).filter(Boolean)).size,
        uploads: events.filter((e) => e.type === 'upload').length,
        packsSigned: signed.length, packsSent: papers.filter((p) => p.sentAt).length, medianMinutesToSigned: median,
        autonomyRate: signed.length ? Math.round((signed.filter((p) => !p.deskEdits && !p.houseEdits).length / signed.length) * 1000) / 1000 : null,
        lastActivityAt: all('activity', w.id).map((a) => a.at).sort().pop() || null,
      };
    });
    const counted = houses.filter((h) => h.inTotals);
    const sum = (k) => counted.reduce((n, h) => n + (Number(h[k]) || 0), 0);
    return {
      houses,
      totals: { liveShipments: sum('liveShipments'), activeUsers7d: sum('activeUsers7d'), packsSigned: sum('packsSigned'), packsSent: sum('packsSent'),
        medianMinutesToSigned: counted.find((h) => h.medianMinutesToSigned != null)?.medianMinutesToSigned ?? null,
        autonomyRate: counted.find((h) => h.autonomyRate != null)?.autonomyRate ?? null },
      generatedAt: new Date().toISOString(),
    };
  }

  return api;
}
