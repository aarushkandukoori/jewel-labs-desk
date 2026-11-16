// The in-browser stand-in for window.jl, so the app runs on the website and in tests without Electron.
// Same methods and answers as src/main/preload.cjs + ipc.js. It plays a run of the agents: a recorded one
// from demo/sample-run.json when that file holds one, else the built-in scripted run (demo/sample.js).
// Everything happens in memory in this tab: nothing is uploaded, sent or saved anywhere.
import { HOUSE, LOCAL, A, B, C, D, QUESTION_A, buildScriptedRun, checksForA, sampleHistory } from './sample.js';
import { exportPackPdf, statementPdf } from './sample-papers.js';
import { qrDataUrl } from './qr.js';

const COLLECTIONS = ['documents', 'shipments', 'stones', 'checks', 'questions', 'papers', 'parties', 'activity', 'messages', 'events'];
const WORLD = { 'shp-a': A, 'shp-b': B, 'shp-c': C, 'shp-d': D };
const OFAC = { count: 19565, date: '2026-11-15', source: 'OFAC SDN list (the desktop app refreshes it every day)' };
const MODEL = 'gpt-5.4-mini';
const DEMO_ONLY = 'This demo runs in your browser only. Download the desktop app to do this for real.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A deep copy (typed arrays such as file bytes survive it), so callers never change our records by accident.
const copy = (v) => (v === undefined ? v : structuredClone(v));

let counter = 0;
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${(++counter).toString(36)}`;

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * options: run (a run object to play instead of loading one), fetchRun (look for demo/sample-run.json; default true
 * in a browser), speed (1 = real time), autoStart (play the run's end state at once; default true).
 */
export function createMockApi({ run: givenRun = null, fetchRun = typeof window !== 'undefined', speed = 1, autoStart = true } = {}) {
  const listeners = new Map(); // event name -> Set of functions
  const workspaces = new Map([[HOUSE.id, { ...HOUSE, createdAt: new Date(Date.now() - 90 * 864e5).toISOString() }], [LOCAL.id, { ...LOCAL, createdAt: new Date().toISOString() }]]);
  const data = new Map(); // workspace id -> { collection -> Map(id -> record) }
  const files = new Map(); // id -> { name, mime, bytes } | url string
  const timers = new Set();
  const settings = { autopilot: true, notifications: true, launchAtLogin: false, userName: null, model: null, signerTitle: 'Director' };
  let current = HOUSE.id;
  let run = null;
  let recorded = false;
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
  function put(collection, record, { wsId = current, silent = false } = {}) {
    const table = tables(wsId)[collection];
    const old = table.get(record.id);
    const at = new Date().toISOString();
    const value = { ...(old || {}), ...record, workspaceId: wsId, createdAt: old?.createdAt || record.createdAt || at, updatedAt: record.updatedAt && !old ? record.updatedAt : at };
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
  const you = { type: 'person', name: 'You (demo)' };
  const usage = (type, extra = {}) => put('events', { id: newId('evt'), type, at: new Date().toISOString(), userId: 'demo-visitor', ...extra }, { silent: true });

  // ---------- playing a run ----------

  async function loadRun() {
    if (givenRun) return givenRun;
    if (fetchRun) {
      try {
        const url = new URL('./sample-run.json', import.meta.url);
        const response = await fetch(url, { cache: 'no-cache' });
        const json = response.ok ? await response.json() : null;
        if (json && Array.isArray(json.steps) && json.steps.length) {
          recorded = true;
          json.baseUrl = url.href;
          return json;
        }
      } catch {
        // no recording: use the scripted run
      }
    }
    return buildScriptedRun(Date.now());
  }

  function stopTimers() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    playing = false;
  }

  function resetSample() {
    stopTimers();
    data.delete(HOUSE.id);
    files.clear();
    for (const [id, f] of Object.entries(run.files || {})) files.set(id, f);
  }

  function applyStep(step, { live }) {
    if (step.kind === 'put') put(step.name, step.payload, { wsId: HOUSE.id, silent: !live || current !== HOUSE.id });
    else if (step.kind === 'remove') { tables(HOUSE.id)[step.name].delete(step.payload?.id); if (live) emit('change', { collection: step.name, id: step.payload?.id, op: 'remove' }); }
    else if (step.kind === 'event' && live && current === HOUSE.id) emit(step.name, step.payload);
  }

  /** Applies the whole run at once (the state a returning visitor sees). */
  function applyInstant() {
    resetSample();
    for (const step of run.steps) applyStep(step, { live: false });
    if (run.final?.collections) for (const [c, rows] of Object.entries(run.final.collections)) for (const r of rows) put(c, r, { wsId: HOUSE.id, silent: true });
  }

  /** Plays the run in real time: steps at their recorded times (divided by speed). */
  function playLive() {
    resetSample();
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
    // A recorded run carries its own SAMPLE house (name, city, letterhead): show that one.
    if (run?.meta?.recorded && run.workspace) {
      const w = workspaces.get(HOUSE.id);
      workspaces.set(HOUSE.id, { ...w, ...run.workspace, id: HOUSE.id });
    }
    if (autoStart) applyInstant();
    else resetSample();
  })();

  // ---------- files: originals and papers ----------

  async function fileOf(id) {
    let f = files.get(id);
    if (typeof f === 'string') {
      const response = await fetch(new URL(f, run.baseUrl || import.meta.url));
      if (!response.ok) throw new Error('That file is not in this demo.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      f = { name: f.split('/').pop(), mime: response.headers.get('content-type') || '', bytes };
      files.set(id, f);
    }
    return f || null;
  }

  function shipmentData(shipmentId) {
    return WORLD[shipmentId] || null;
  }

  async function paperBytes(paper) {
    // Recorded runs ship the real PDFs; fetch them by "<paperId>:<version>:<status>".
    const cached = await fileOf(`${paper.id}:${paper.version}:${paper.status}`)
      || (paper.status === 'signed' ? null : await fileOf(`${paper.id}:${paper.version}:ready_to_sign`).catch(() => null));
    if (cached) return cached;
    const s = shipmentData(paper.shipmentId);
    if (!s) throw new Error('This paper has no file in the demo.');
    const shipmentDocs = all('documents').filter((d) => d.shipmentId === paper.shipmentId);
    const stones = all('stones').filter((st) => st.shipmentId === paper.shipmentId).sort((a, b) => a.id.localeCompare(b.id));
    const checks = all('checks').filter((c) => c.shipmentId === paper.shipmentId);
    const statement = all('papers').find((p) => p.shipmentId === paper.shipmentId && p.kind !== 'export_pack');
    const signer = paper.signedBy ? { name: paper.signedBy, title: paper.signerTitle, at: paper.signedAt } : null;
    const common = { house: HOUSE, shipment: s, stones, ref: paper.ref, version: paper.version, status: paper.status, date: paper.builtAt || paper.createdAt, signer };
    const originalsHash = await sha256Hex(new TextEncoder().encode(shipmentDocs.map((d) => d.sha256).join('')));
    const summary = get('shipments', paper.shipmentId)?.summary;
    const assumed = Array.from({ length: summary?.total || 1 }, () => ({ severity: 'pass' })); // older shipments keep only their summary
    const built = paper.kind === 'export_pack'
      ? exportPackPdf({ ...common, docs: shipmentDocs, checks: checks.length ? checks : assumed, originalsHash,
        statementRef: statement?.ref, statementLabel: statement?.kind === 'eu_dds' ? 'EU Due Diligence Statement' : 'US CBP self-certification' })
      : statementPdf({ ...common, kind: paper.kind });
    const f = { name: `${paper.ref}-v${paper.version}${signer ? '-signed' : ''}.pdf`, mime: 'application/pdf', bytes: built.bytes, pages: built.pages, contents: built.contents };
    files.set(`${paper.id}:${paper.version}:${paper.status}`, f);
    return f;
  }

  /** Builds (or rebuilds) the papers for a shipment: statements first, then the pack. */
  async function buildPapers(shipmentId, { kinds, status = 'ready_to_sign' } = {}) {
    const shipment = get('shipments', shipmentId);
    if (!shipment) throw new Error('That shipment is not here.');
    const wanted = kinds?.length ? kinds : [...(shipment.required || []).map((r) => r.kind).filter((k) => k !== 'export_pack'), 'export_pack'];
    const built = [];
    const day = new Date();
    const mmdd = `${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
    for (const kind of wanted) {
      const prefix = { export_pack: 'EXP', eu_dds: 'DDS', us_cbp_certificate: 'CBP', import_pack: 'IMP', g7_gf_declaration: 'G7' }[kind] || 'DOC';
      const existing = all('papers').find((p) => p.shipmentId === shipmentId && p.kind === kind);
      const label = { export_pack: 'Building the export paper', eu_dds: 'Writing the EU statement', us_cbp_certificate: 'Writing the US self-certification' }[kind] || 'Building the paper';
      agentEvent('paperwork', 'paper', `${label} for ${shipment.ref}`, { shipmentId });
      await sleep(900 / speed);
      const now = new Date().toISOString();
      const version = existing ? (existing.status === 'signed' || existing.status === 'sent' ? existing.version : existing.version + 1) : 1;
      if (existing && (existing.status === 'signed' || existing.status === 'sent')) { built.push(existing); continue; }
      const paper = {
        id: existing?.id || `pap-${shipmentId.slice(4)}-${kind}`, shipmentId, kind, ref: existing?.ref || `JL-${prefix}-${mmdd}-01`, version, status,
        fileKey: `papers/${kind}`, sha256: '', pages: 0, contents: [], deskEdits: 0, houseEdits: 0, builtAt: now, builtBy: 'Paperwork', signedBy: null, signedAt: null,
        versions: [...(existing?.versions || []), { version, builtAt: now, status }],
      };
      const f = await paperBytes(paper);
      paper.sha256 = await sha256Hex(f.bytes);
      paper.pages = f.pages;
      paper.contents = f.contents;
      built.push(put('papers', paper));
      log({ type: 'agent', name: 'Paperwork' }, 'built', `Built ${kind === 'export_pack' ? 'Export pack' : kind === 'eu_dds' ? 'EU Due Diligence Statement (draft)' : 'US CBP self-certification'} ${paper.ref} v${version}`, { shipmentId, paperId: paper.id });
    }
    put('shipments', { ...shipment, status });
    agentEvent('paperwork', 'done', `${built.map((p) => p.ref).join(' and ')}: ${status === 'held_for_review' ? 'held for review' : 'ready to sign'}`, { shipmentId });
    const ref = built.find((p) => p.kind === 'export_pack')?.ref || built[0]?.ref;
    if (status === 'held_for_review') emit('notify', { title: `Held for review: ${ref}`, body: `${shipment.ref}: Jewel Labs checks it before you sign.`, kind: 'desk_message', shipmentId });
    else emit('notify', { title: `Ready to sign: ${ref}`, body: `${shipment.ref}: every check is consistent. Sign it, then send it from your mailbox.`, kind: 'pack_ready', shipmentId });
    return copy(built);
  }

  // After a question is answered: the rules run again and, with nothing open, the papers are built.
  async function afterAnswer(question, answer) {
    const shipment = get('shipments', question.shipmentId);
    if (!shipment) return;
    await sleep(700 / speed);
    agentEvent('origin', 'check', `Re-checking ${shipment.ref} with your answer: ${answer}`, { shipmentId: shipment.id });
    if (question.id === QUESTION_A.id) {
      for (const c of checksForA({ answered: true })) put('checks', c);
      put('shipments', { ...shipment, summary: { passed: 14, total: 14 } });
    }
    await sleep(900 / speed);
    agentEvent('origin', 'done', `${shipment.ref}: every check is consistent`, { shipmentId: shipment.id });
    log({ type: 'agent', name: 'Origin' }, 'checked', `${shipment.ref}: 14 of 14 checks consistent after the house's answer`, { shipmentId: shipment.id });
    const open = all('questions').filter((q) => q.shipmentId === shipment.id && q.status === 'open');
    if (!open.length && settings.autopilot) await buildPapers(shipment.id);
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

  async function addFiles(list) {
    const ids = [];
    for (const item of Array.from(list || [])) {
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

  async function ask(text, { shipmentId } = {}) {
    const request = String(text || '').trim();
    if (!request) throw new Error('Type a request for the agents.');
    const at = () => new Date().toISOString();
    put('messages', { id: newId('msg'), at: at(), from: 'house', author: 'You (demo)', text: request, shipmentId: shipmentId || null });
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
        steps.push('Matching your documents');
        agentEvent('records', 'done', `Matched ${all('documents').filter((d) => d.shipmentId === shipment.id).length} documents to ${shipment.ref}`, { shipmentId: shipment.id });
        await sleep(800 / speed);
        steps.push('Sanctions check');
        agentEvent('sanctions', 'screen', `${shipment.consignee?.name}: no match on the OFAC SDN list`, { shipmentId: shipment.id });
        await sleep(800 / speed);
        steps.push('Checking the documents');
        agentEvent('origin', 'check', `Running the rules on ${shipment.ref}`, { shipmentId: shipment.id });
        await sleep(800 / speed);
        const qs = all('questions').filter((q) => q.shipmentId === shipment.id && q.status === 'open');
        if (qs.length) {
          reply = `${shipment.ref} has ${qs.length === 1 ? 'one open question' : `${qs.length} open questions`} first: ${qs.map((q) => q.text).join(' ')}`;
          actions = qs.map((q) => ({ kind: 'question', questionId: q.id, text: q.text }));
        } else {
          const kinds = /eu|statement|dds/i.test(request) && shipment.destinationCountry === 'BE' ? ['eu_dds', 'export_pack'] : undefined;
          for (const k of kinds || [...(shipment.required || []).map((r) => r.kind).filter((x) => x !== 'export_pack'), 'export_pack']) {
            steps.push({ export_pack: 'Building the export paper', eu_dds: 'Writing the EU statement', us_cbp_certificate: 'Writing the US self-certification' }[k] || 'Building the paper');
          }
          const papers = await buildPapers(shipment.id, { kinds, status: shipment.status === 'held_for_review' ? 'held_for_review' : 'ready_to_sign' });
          reply = `${papers.map((p) => `${p.ref} v${p.version}`).join(', ')}: ${papers.some((p) => p.status === 'held_for_review') ? 'held for review. Jewel Labs checks it before you sign.' : 'ready to sign.'}`;
          actions = papers.map((p) => ({ kind: 'paper', paperId: p.id, ref: p.ref, status: p.status }));
        }
      }
    } else if (/status|where|how.*going/i.test(request)) {
      reply = open.map((s) => `${s.ref}: ${s.status.replace(/_/g, ' ')}.`).join('\n') || 'Every shipment is signed or sent.';
    } else {
      reply = 'I can prepare the papers for a shipment, tell you what is still missing, or say where each shipment stands. In the desktop app the agents answer with the AI model; this demo knows those three requests.';
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
    workspaceId: current, sample: current === HOUSE.id, cloud: false, signedIn: false, role: 'owner', deskAllowed: true,
    ai: { mode: 'demo', model: MODEL, available: true }, autopilot: settings.autopilot, secureStorage: false, site: null, repo: null,
  });
  const auth = () => ({ cloud: false, signedIn: false, user: null, role: 'owner', deskAllowed: true });
  const workspaceOut = (w) => ({ ...w, kind: 'local', sample: w.id === HOUSE.id, role: 'owner' });
  const select = (id) => {
    if (!workspaces.has(id)) throw new Error('That workspace was not found.');
    current = id;
    emit('sync', { reason: 'opened', workspaceId: id, kind: 'local' });
    return workspaceOut(workspaces.get(id));
  };
  const screenName = (name) => {
    const known = all('parties', HOUSE.id).find((p) => p.name.toLowerCase() === String(name).toLowerCase());
    if (known || /\(SAMPLE\)|nilgiri star|^jewel labs$/i.test(name)) return { name, status: 'clear', best: null, compared: known?.screening?.compared ?? 40, listDate: OFAC.date };
    return { name, status: 'review', best: null, compared: 0, note: 'The demo does not carry the OFAC list. The desktop app screens every name against all 19,565 entries.' };
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
      members: ok(() => (current === HOUSE.id
        ? [{ name: 'You (demo)', email: null, role: 'owner', you: true }, { id: 'u-kiran', name: 'Kiran (sample)', email: 'kiran@nilgiri-star.example.com', role: 'preparer' }, { id: 'u-asha', name: 'A. Mehta (sample)', email: 'asha@nilgiri-star.example.com', role: 'owner' }]
        : [{ name: 'You (demo)', email: null, role: 'owner', you: true }])),
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
        const events = Array.isArray(stone.history) && stone.history.length ? stone.history : sampleHistory(stone, { documents: all('documents'), papers: all('papers') });
        return { stone, shipment: get('shipments', stone.shipmentId), events };
      }),
      verify: ok(async (stoneId) => {
        const stone = get('stones', stoneId);
        if (!stone) throw new Error('That stone is no longer there.');
        agentEvent('records', 'check', `Opening the ${stone.lab} report check for ${stone.reportNumber}`, { shipmentId: stone.shipmentId });
        await sleep(1200 / speed);
        const labCheck = { status: 'match', diffs: [], checkedAt: new Date().toISOString(), checkedBy: 'You (demo)', lab: stone.lab, demo: true };
        put('stones', { ...stone, labCheck });
        log(you, 'lab check', `${stone.lab} report ${stone.reportNumber}: matches our record (demo: the desktop app opens the lab's own page)`, { shipmentId: stone.shipmentId });
        return labCheck;
      }),
    },
    questions: {
      list: ok((q) => list('questions', q)),
      answer: ok(async (id, answer) => {
        const q = get('questions', id);
        if (!q) throw new Error('That question is no longer there.');
        const saved = put('questions', { ...q, status: 'answered', answer, answeredBy: 'You (demo)', answeredAt: new Date().toISOString() });
        usage('question_answered', { shipmentId: q.shipmentId });
        log(you, 'answered', `Answered: ${q.text} ${answer}`, { shipmentId: q.shipmentId });
        afterAnswer(q, answer);
        return saved;
      }),
      dismiss: ok((id) => {
        const q = get('questions', id);
        if (!q) throw new Error('That question is no longer there.');
        log(you, 'question.dismiss', `Dismissed: ${q.text}`, { shipmentId: q.shipmentId });
        return put('questions', { ...q, status: 'dismissed', answeredBy: 'You (demo)', answeredAt: new Date().toISOString() });
      }),
    },
    papers: {
      list: ok((q) => list('papers', q)),
      build: ok((shipmentId, kinds) => buildPapers(shipmentId, { kinds })),
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
        const others = all('papers').filter((p) => p.shipmentId === paper.shipmentId && !['signed', 'sent'].includes(p.status));
        if (!others.length) put('shipments', { ...get('shipments', paper.shipmentId), status: 'signed' });
        usage('pack_signed', { paperId: id, shipmentId: paper.shipmentId });
        log({ type: 'person', name: next.signedBy }, 'signed', `Signed ${paper.ref} v${paper.version}`, { shipmentId: paper.shipmentId, paperId: id });
        return saved;
      }),
      send: ok(() => ({ error: 'This demo cannot send email. In the desktop app the signed pack goes from your own mailbox. Download it instead.', code: 'no_mailbox', download: true })),
      save: ok(() => ({ canceled: true })),
    },
    agents: {
      run: ok(async ({ shipmentId } = {}) => {
        const s = shipmentId ? get('shipments', shipmentId) : null;
        agentEvent('records', 'done', s ? `Re-filed every paper of ${s.ref}` : 'Looked over every open shipment', { shipmentId });
        await sleep(500 / speed);
        agentEvent('sanctions', 'screen', 'Parties screened again: no match on the OFAC SDN list', { shipmentId });
        await sleep(500 / speed);
        agentEvent('origin', 'done', 'Rules run again: nothing changed', { shipmentId });
        log({ type: 'agent', name: 'Origin' }, 'checked', s ? `Ran the agents on ${s.ref}: nothing changed` : 'Ran the agents on every open shipment: nothing changed', { shipmentId });
        return { ran: true };
      }),
      ask: ok(ask),
      autopilot: ok((on) => { if (typeof on === 'boolean') { settings.autopilot = on; emit('sync', { reason: 'autopilot', autopilot: on }); } return settings.autopilot; }),
    },
    activity: { list: ok((q) => list('activity', q)) },
    messages: {
      list: ok((q) => list('messages', q)),
      send: ok((msg) => put('messages', { id: newId('msg'), at: new Date().toISOString(), from: msg.to === 'house' ? 'desk' : 'house', author: 'You (demo)', text: msg.text, shipmentId: msg.shipmentId || null })),
    },
    desk: {
      queue: ok(() => all('papers').filter((p) => p.status === 'held_for_review').map((paper) => ({
        paper, shipment: get('shipments', paper.shipmentId),
        checks: all('checks').filter((c) => c.shipmentId === paper.shipmentId && c.severity !== 'pass'),
        questions: all('questions').filter((q) => q.shipmentId === paper.shipmentId && q.status === 'open'),
      }))),
      approve: ok((paperId, message) => {
        const paper = get('papers', paperId);
        if (!paper) throw new Error('That paper is no longer there.');
        const text = message || `${paper.ref} is approved and ready to sign.`;
        const saved = put('papers', { ...paper, status: 'ready_to_sign', deskNote: message || null, approvedBy: 'You (demo)', approvedAt: new Date().toISOString() });
        put('shipments', { ...get('shipments', paper.shipmentId), status: 'ready_to_sign' });
        put('messages', { id: newId('msg'), at: new Date().toISOString(), from: 'desk', to: 'house', kind: 'desk', author: 'You (demo)', text, shipmentId: paper.shipmentId, paperId });
        log(you, 'approved', `Approved ${paper.ref} v${paper.version}`, { shipmentId: paper.shipmentId, paperId });
        emit('notify', { title: `Ready to sign: ${paper.ref}`, body: text, kind: 'pack_ready' });
        return saved;
      }),
      hold: ok((paperId, message) => {
        const paper = get('papers', paperId);
        if (!paper) throw new Error('That paper is no longer there.');
        const text = message || `${paper.ref} is held for review.`;
        const saved = put('papers', { ...paper, status: 'held_for_review', deskNote: text, heldBy: 'You (demo)', heldAt: new Date().toISOString() });
        put('messages', { id: newId('msg'), at: new Date().toISOString(), from: 'desk', to: 'house', kind: 'desk', author: 'You (demo)', text, shipmentId: paper.shipmentId, paperId });
        log(you, 'held', `Held ${paper.ref} v${paper.version}: ${text}`, { shipmentId: paper.shipmentId, paperId });
        return saved;
      }),
      houses: ok(() => [...workspaces.values()].map(workspaceOut)),
      onboard: ok((profile) => {
        const w = { id: newId('ws'), name: profile.name, legalName: profile.legalName || null, country: profile.country || null, city: profile.city || null, autopilot: profile.autopilot !== false, createdAt: new Date().toISOString() };
        workspaces.set(w.id, w);
        return { workspace: workspaceOut(w), screening: screenName(profile.legalName || profile.name), invite: { error: `Portal logins are created in the desktop app. ${DEMO_ONLY}` } };
      }),
    },
    sanctions: { status: ok(() => OFAC), screen: ok(screenName), refresh: ok(() => OFAC) },
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
      load: ok(() => { if (current !== HOUSE.id) current = HOUSE.id; playLive(); emit('sync', { reason: 'opened', workspaceId: HOUSE.id, kind: 'local' }); return { started: true, recorded }; }),
      reset: ok(() => { resetSample(); emit('sync', { reason: 'opened', workspaceId: HOUSE.id, kind: 'local' }); return true; }),
      status: ok(() => ({ recorded, playing, title: run?.meta?.title || 'Sample run' })),
      skip: ok(() => { applyInstant(); emit('sync', { reason: 'opened', workspaceId: HOUSE.id, kind: 'local' }); return true; }),
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

  function metrics() {
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
      const sample = w.id === HOUSE.id;
      return {
        id: w.id, name: w.name, environment: sample ? 'sandbox' : 'live', inTotals: true,
        liveShipments: all('shipments', w.id).filter((s) => s.status !== 'sent').length,
        signInsLast7d: sample ? 9 + events.filter((e) => e.type === 'sign_in').length : 1, activeUsers7d: sample ? 3 : 1,
        uploads: events.filter((e) => e.type === 'upload').length + (sample ? 15 : 0),
        packsSigned: signed.length, packsSent: papers.filter((p) => p.sentAt).length, medianMinutesToSigned: median,
        autonomyRate: signed.length ? Math.round((signed.filter((p) => !p.deskEdits && !p.houseEdits).length / signed.length) * 1000) / 1000 : null,
        lastActivityAt: all('activity', w.id).map((a) => a.at).sort().pop() || null,
      };
    });
    const sum = (k) => houses.reduce((n, h) => n + (Number(h[k]) || 0), 0);
    return {
      houses,
      totals: { liveShipments: sum('liveShipments'), activeUsers7d: sum('activeUsers7d'), packsSigned: sum('packsSigned'), packsSent: sum('packsSent'),
        medianMinutesToSigned: houses.find((h) => h.medianMinutesToSigned != null)?.medianMinutesToSigned ?? null,
        autonomyRate: houses.find((h) => h.autonomyRate != null)?.autonomyRate ?? null },
      generatedAt: new Date().toISOString(),
    };
  }

  return api;
}
