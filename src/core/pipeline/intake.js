// Intake agent: reads every new document. Text layer first, OCR for photos and scans, then the model
// (or the offline reader) classifies and extracts the fields, and each field gets its spot on the page.
import { DOC_TYPE_LABELS, FIELD_LABELS } from '../types.js';
import { MAX_RETRIES } from './retrieval.js';

const MAX_OCR_PAGES = 8; // a scanned PDF longer than this is only read on its first pages
const PAGE_DRAW_TIMEOUT_MS = 60_000; // drawing one page of a scan; a page that hangs must not stop every later run
// Image types OCR or the model can look at. Anything else (HEIC, TIFF, AVIF) cannot be read yet.
const READABLE_IMAGES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp', 'image/gif'];
const MAX_HINT_CHARS = 24000; // text sent to the model with each request
const MAX_SAVED_TEXT = 20000; // text kept on the document for search and for people to read; the store copies it often
const MIN_TEXT_LAYER_CHARS = 40; // a "text layer" shorter than this is really a scan
const CHAT_KEPT = 40; // messages of a read chat kept on its record, for the chat view

/** Reads documents, at most `parallel` at a time. shouldStop() true: start no more (the run lost its lease). */
export async function readDocuments(ctx, docs, { parallel = 3, shouldStop = () => false } = {}) {
  const results = [];
  await eachLimited(docs, parallel, async (doc) => { results.push(await readOneDocument(ctx, doc)); }, shouldStop);
  return results;
}

/** Runs fn over the list with at most `limit` running at once. */
export async function eachLimited(list, limit, fn, shouldStop = () => false) {
  let next = 0;
  async function worker() {
    while (next < list.length && !shouldStop()) {
      const item = list[next];
      next += 1;
      await fn(item);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker);
  await Promise.all(workers);
}

export async function readOneDocument(ctx, doc) {
  const { store } = ctx;
  // A paper removed while it waited (or while it was read) stays removed: the agents never put it back.
  const gone = async () => !(await store.get('documents', doc.id));
  if (await gone()) return null;
  const cannot = unreadableReason(doc);
  if (cannot) return failRead(ctx, doc, cannotRead(cannot), gone);
  await store.put('documents', { ...doc, status: 'reading' });
  ctx.agentEvent('intake', 'start', `Reading ${doc.fileName}`, { docId: doc.id });
  try {
    const bytes = await store.getFile(doc.fileKey);
    const ai = await ctx.getAI();
    let result;
    if (doc.kind === 'chat') result = await readChat(ctx, ai, doc);
    else if (doc.kind === 'email') result = await readEmail(ctx, ai, doc);
    else result = await readPaper(ctx, ai, doc, bytes);

    if (await gone()) return null;
    // Read by the offline reader because an AI call failed (and could work later): the worker reads it again once
    // the AI is back (worker.js), and until then the rules ask a person to confirm it (compliance.js read_offline).
    const done = {
      ...doc, ...result, status: 'read', error: null, readBy: result.readBy || readerName(ai), readAt: ctx.nowIso(),
      needsAiRead: Boolean(result.aiError && ai.available),
    };
    await store.put('documents', done);
    await ctx.log(ctx.agentActor('intake'), 'read', describe(done), { docId: doc.id });
    // Work is done and saved; now show it. The field events play on their own paced queue.
    ctx.playFields(fieldEvents(done));
    return done;
  } catch (err) {
    return failRead(ctx, doc, err, gone);
  }
}

/** Saves a paper that could not be read with the reason. A file that can never be read is not tried again. */
async function failRead(ctx, doc, err, gone) {
  if (await gone()) return null;
  const failed = { ...doc, status: 'error', error: err.message, ...(err.permanent ? { retries: MAX_RETRIES } : {}) };
  await ctx.store.put('documents', failed);
  const message = `Could not read ${doc.fileName}: ${err.message}`;
  ctx.agentEvent('intake', 'error', message, { docId: doc.id });
  await ctx.log(ctx.agentActor('intake'), 'error', message, { docId: doc.id });
  return failed;
}

/** An error that reading again will not fix (a locked PDF, a photo format we cannot open). */
function cannotRead(message) {
  return Object.assign(new Error(message), { permanent: true });
}

/** Why the agents cannot read this kind of file at all, or null. Nothing is sent to the model for these. */
export function unreadableReason(doc) {
  const mime = String(doc.mime || '').toLowerCase();
  if (doc.kind === 'image' && !READABLE_IMAGES.includes(mime)) {
    const format = mime.replace(/^image\//, '').toUpperCase() || 'this format';
    return `Pictures saved as ${format} cannot be read yet. Save it as JPEG or PDF and add it again.`;
  }
  if (doc.kind !== 'other') return null;
  if (mime === 'application/vnd.ms-outlook') {
    return 'Outlook .msg files cannot be read yet. Save the email as .eml, or its attachments as PDF, and add them again.';
  }
  if (/word/.test(mime)) return 'Word files cannot be read yet. Save it as PDF and add it again.';
  if (/^(audio|video)\//.test(mime)) return 'Videos and voice notes are not read. If it shows a paper, add a photo or a PDF of the paper instead.';
  return 'This kind of file cannot be read. Save it as PDF and add it again.';
}

async function readPaper(ctx, ai, doc, bytes) {
  const page = await pageText(ctx, doc, bytes);
  const item = { name: doc.fileName, mime: doc.mime, kind: doc.kind, bytes };
  const textHint = page.text.slice(0, MAX_HINT_CHARS);
  const house = await ctx.store.workspace();
  const classified = (await ai.classify(item, { textHint })) || {};
  const extraction = (await ai.extract(item, classified.docType || 'other', {
    textHint, pageTexts: page.pageTexts, pageImages: page.pageImages, textSource: page.ocrUsed ? 'ocr' : 'layer', house: houseBrief(house),
  })) || {};
  const records = await ctx.load('records');
  // Who sells to whom decides between the house's own invoice and its supplier's (see invoiceTypeForHouse).
  const settled = invoiceTypeForHouse(classified.docType || 'other', splitJointNames(extraction.fields || [], house, records), house, records);
  return {
    docType: settled.docType,
    classifyConfidence: classified.confidence ?? 0,
    classifyReason: settled.reason || classified.reason || null,
    summary: extraction.summary || null,
    fields: placeFields(records.locate, settled.fields, page.words),
    lines: extraction.lines || [],
    declarations: extraction.declarations || [],
    warnings: extraction.warnings || [],
    readBy: extraction.readBy ? readerLabel(extraction.readBy) : null,
    aiError: extraction.aiError || classified.aiError || null,
    pages: page.pages,
    hasTextLayer: page.hasTextLayer,
    pageSizes: page.pageSizes,
    ocrUsed: page.ocrUsed,
    text: page.text.slice(0, MAX_SAVED_TEXT),
  };
}

/** What the reader is told about the house that received the paper. */
function houseBrief(house) {
  if (!house) return null;
  return { name: house.legalEntity || house.letterhead?.companyName || house.name || null, role: house.role || null, country: house.country || null };
}

const JOINT = /\s+and\s*\/\s*or\s+/i;

/**
 * "Kavya Gems LLP and/or Lumen Diamant BV" (an insurance certificate "for account of" both) read as one party:
 * the house keeps its own role (exporter, supplier) and the other company takes the other (consignee, buyer).
 * Without a house name the last company is taken for the consignee, the first for the exporter.
 */
export function splitJointNames(fields, house, records) {
  const names = records?.houseNames ? records.houseNames(house) : [];
  const isHouse = (name) => names.some((houseName) => records.namesMatch(name, houseName));
  return fields.map((field) => {
    if (!/\.name$/.test(String(field.key)) || !JOINT.test(String(field.value))) return field;
    const parts = String(field.value).split(JOINT).map((part) => part.trim()).filter(Boolean);
    const ours = ['exporter', 'supplier'].includes(String(field.key).split('.')[0]);
    const value = ours
      ? parts.find(isHouse) || parts[0]
      : (names.length && parts.find((part) => !isHouse(part))) || parts[parts.length - 1];
    return { ...field, value };
  });
}

const INVOICE_TYPES = ['commercial_invoice', 'proforma_invoice', 'supplier_invoice'];
const PARTY_PARTS = ['name', 'address', 'country', 'taxId'];

/**
 * An invoice says who sells to whom. For a house that exports or manufactures, an invoice where another company
 * sells to the house is a purchase: a supplier invoice (rough or polished bought in). One where the house sells is
 * its own commercial invoice. An importer's or trader's purchases stay as they were read (they are the invoices of
 * its imports). On a supplier invoice the seller is the supplier, so the seller's fields move to supplier.*.
 */
export function invoiceTypeForHouse(docType, fields, house, records) {
  const keep = { docType, fields, reason: null };
  if (!INVOICE_TYPES.includes(docType) || !records?.namesMatch || !records?.houseNames) return keep;
  const names = records.houseNames(house);
  if (!names.length) return keep;
  const value = (key) => fields.find((f) => f.key === key && f.value)?.value || null;
  const isHouse = (name) => Boolean(name) && names.some((houseName) => records.namesMatch(name, houseName));
  const seller = value('supplier.name') || value('exporter.name');
  const buyer = value('consignee.name') || value('buyer.name');
  const houseSells = isHouse(value('exporter.name')) || isHouse(value('supplier.name'));
  const houseBuys = isHouse(buyer);
  const buysIn = ['exporter', 'manufacturer'].includes(String(house?.role || 'exporter').toLowerCase());
  if (docType !== 'supplier_invoice' && buysIn && houseBuys && !houseSells && seller) {
    const moved = fields.map((f) => {
      const [role, part] = String(f.key).split('.');
      const free = !fields.some((x) => x.key === `supplier.${part}`);
      return role === 'exporter' && PARTY_PARTS.includes(part) && free ? { ...f, key: `supplier.${part}` } : f;
    });
    return { docType: 'supplier_invoice', fields: moved, reason: `Supplier invoice: ${seller} sells to the house` };
  }
  if (docType === 'supplier_invoice' && houseSells && !houseBuys) {
    return { docType: 'commercial_invoice', fields, reason: 'Commercial invoice: the house is the seller' };
  }
  return keep;
}

/** Text and word boxes for one document, from its text layer or OCR. */
async function pageText(ctx, doc, bytes) {
  const empty = { text: '', pageTexts: undefined, words: [], pages: 1, hasTextLayer: false, pageSizes: [], pageImages: undefined, ocrUsed: false };
  if (doc.kind === 'pdf') return pdfText(ctx, bytes);
  if (doc.kind === 'image') {
    const ocr = await ocrPage(ctx, bytes, 1);
    return { ...empty, text: ocr.text, pageTexts: [ocr.text], words: ocr.words, ocrUsed: true };
  }
  if (doc.kind === 'sheet') return { ...empty, text: doc.content?.sheet?.text || '', hasTextLayer: true };
  if (doc.kind === 'text') return { ...empty, text: doc.content?.text || new TextDecoder().decode(bytes), hasTextLayer: true };
  return empty;
}

async function pdfText(ctx, bytes) {
  const ingest = await ctx.load('ingest');
  const info = await ingest.pdfInfo(bytes);
  // A locked or damaged PDF: say why in plain words, and do not try to draw pages it does not have.
  if (info.error || !info.pages) {
    const reason = info.error || 'This PDF has no pages.';
    throw cannotRead(`${reason} ${/password/i.test(reason) ? 'Remove the password and add it again.' : 'Add a copy that opens.'}`);
  }
  const result = {
    text: info.text || '', pageTexts: info.pageTexts, words: info.words || [], pages: info.pages || 1,
    hasTextLayer: !!info.hasTextLayer, pageSizes: info.pageSizes || [], pageImages: undefined, ocrUsed: false,
  };
  if (result.hasTextLayer && result.text.trim().length >= MIN_TEXT_LAYER_CHARS) return result;
  if (typeof ctx.rasterize !== 'function') return result; // no way to draw the pages: read what text there is

  // A scan: draw each page as an image, OCR it, and give the images to the vision model too.
  const pageImages = []; // data URLs, the form the AI module sends to the model
  const words = [];
  const texts = [];
  for (let pageNo = 1; pageNo <= Math.min(result.pages, MAX_OCR_PAGES); pageNo += 1) {
    const png = await withTimeout(ctx.rasterize(bytes, pageNo), ctx.pageDrawTimeoutMs || PAGE_DRAW_TIMEOUT_MS, `Drawing page ${pageNo} of this scan took too long.`);
    pageImages.push(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
    const ocr = await ocrPage(ctx, png, pageNo);
    words.push(...ocr.words);
    texts.push(ocr.text);
  }
  return { ...result, text: texts.join('\n'), pageTexts: texts, words, pageImages, ocrUsed: true };
}

/** OCR one page image. A failed OCR gives empty text, so the vision model can still read the page. */
async function ocrPage(ctx, imageBytes, pageNo) {
  try {
    const ocr = await ctx.getOCR();
    const out = await ocr.ocrImage(imageBytes, { page: pageNo });
    if (out.error) ctx.agentEvent('intake', 'error', `OCR could not read page ${pageNo}: ${out.error}`);
    const words = (out.words || []).map((w) => normalizeWord(w, out.width, out.height, pageNo));
    return { text: out.text || '', words };
  } catch (err) {
    ctx.agentEvent('intake', 'error', `OCR could not read page ${pageNo}: ${err.message}`);
    return { text: '', words: [] };
  }
}

/** Word boxes are 0..1 of the page. If OCR gave pixels, divide by the image size. */
function normalizeWord(word, width, height, pageNo) {
  const inPixels = Math.max(word.x1, word.y1) > 1.5 && width > 0 && height > 0;
  const sx = inPixels ? width : 1;
  const sy = inPixels ? height : 1;
  return { ...word, page: pageNo, x0: word.x0 / sx, y0: word.y0 / sy, x1: word.x1 / sx, y1: word.y1 / sy };
}

/** Adds the page box to every field that does not have one yet: find its quote among the words, else its value. */
export function placeFields(locate, fields, words) {
  return fields.filter((f) => f && f.key).map((f) => {
    const field = { ...f, page: f.page ?? null, box: f.box || null, agent: 'intake' };
    if (field.box || !words.length || typeof locate !== 'function') return field;
    const hint = { page: f.page ?? undefined };
    const spot = (f.quote && locate(words, String(f.quote), hint)) || (f.value && locate(words, String(f.value), hint)) || null;
    return spot ? { ...field, page: spot.page, box: spot.box } : field;
  });
}

async function readChat(ctx, ai, doc) {
  const chat = doc.content?.chat || { title: doc.fileName, messages: [] };
  const house = await ctx.store.workspace();
  const allowed = house.permissions?.readWhatsApp !== false;
  const insight = allowed ? (await ai.readChat(chat)) || {} : {};
  await saveRequests(ctx, doc, insight.requests || [], 'chat');
  const total = chat.messages?.length || 0;
  return {
    ...readByOf(insight),
    docType: 'whatsapp_chat', classifyConfidence: 1, pages: 0, hasTextLayer: true, fields: [], lines: [], declarations: [],
    summary: allowed ? `${total} messages, ${(insight.relevant || []).length} about shipments` : `${total} messages (reading chats is off for this house)`,
    insights: { relevant: insight.relevant || [], requests: insight.requests || [], packing: insight.packing || [] },
    refs: insight.refs || [],
    aiError: insight.aiError || null,
    // Once read, the insights hold what matters and the full chat stays in the original _chat.txt file; the
    // last messages stay on the record so the chat can be shown. A chat the AI could not read keeps all its
    // messages, so the AI can read it again later.
    content: allowed && !insight.aiError
      ? { chat: { title: chat.title, messageCount: total, messages: (chat.messages || []).slice(-CHAT_KEPT) } }
      : doc.content,
  };
}

async function readEmail(ctx, ai, doc) {
  const email = doc.content?.email || {};
  const insight = (await ai.readEmail(email)) || {};
  await saveRequests(ctx, doc, insight.requests || [], 'email');
  return {
    ...readByOf(insight),
    docType: 'email', classifyConfidence: 1, pages: 0, hasTextLayer: true, fields: [], lines: [], declarations: [],
    summary: `Email from ${email.from || 'unknown sender'}: ${email.subject || '(no subject)'}`,
    insights: { relevant: insight.relevant || [], requests: insight.requests || [] },
    refs: insight.refs || [],
    aiError: insight.aiError || null,
  };
}

/** A request in a chat or email ("send the packing list for EXP/28") becomes a message for the desk and the house. */
async function saveRequests(ctx, doc, requests, channel) {
  for (const request of requests) {
    if (!request?.text) continue;
    // Each chat request names who wrote it; an email's requests come from its sender.
    const author = request.author || doc.source?.chatAuthor || doc.content?.email?.from || 'House';
    await ctx.postMessage({
      from: { type: 'person', name: author, role: 'house' }, to: 'desk', text: request.text,
      kind: 'request', channel, docId: doc.id, ref: request.ref || null, status: 'open',
    });
    await ctx.log(ctx.agentActor('intake'), 'request', `Asked in the ${channel}: ${request.text}`, { docId: doc.id });
  }
}

function fieldEvents(doc) {
  const head = { agent: 'intake', action: 'read', docId: doc.id, message: describe(doc) };
  const fields = (doc.fields || []).filter((f) => f.value != null && f.value !== '').map((f) => {
    const label = FIELD_LABELS[f.key] || f.key;
    return {
      agent: 'intake', action: 'field', docId: doc.id, page: f.page, key: f.key, label, value: String(f.value), box: f.box,
      message: `${label}: ${f.value}`,
    };
  });
  return [head, ...fields];
}

function describe(doc) {
  if (doc.kind === 'chat' || doc.kind === 'email') return `${doc.fileName}: ${doc.summary}`;
  const label = DOC_TYPE_LABELS[doc.docType] || 'Document';
  const count = (doc.fields || []).length;
  return `${doc.fileName}: ${label}, ${count} field${count === 1 ? '' : 's'} read${doc.ocrUsed ? ' with OCR' : ''}`;
}

function readerName(ai) {
  return ai.mode === 'off' ? 'Offline reader' : ai.model || 'AI reader';
}

/** extraction.readBy is 'ai:<model>', 'offline' or 'mock'. */
function readerLabel(readBy) {
  if (readBy === 'offline') return 'Offline reader';
  return String(readBy).replace(/^ai:/, '');
}

/**
 * Who read a chat or an email ('ai:<model>', or 'offline' when the model failed and the offline reader stood in),
 * and what went wrong ("Read offline: ..."). Without either, readOneDocument names the reader from the AI's mode.
 */
function readByOf(insight) {
  return { warnings: insight.warnings || [], ...(insight.readBy ? { readBy: readerLabel(insight.readBy) } : {}) };
}

function withTimeout(promise, ms, message) {
  let timer;
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
