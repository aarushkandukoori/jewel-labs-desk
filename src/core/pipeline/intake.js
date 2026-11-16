// Intake agent: reads every new document. Text layer first, OCR for photos and scans, then the model
// (or the offline reader) classifies and extracts the fields, and each field gets its spot on the page.
import { DOC_TYPE_LABELS, FIELD_LABELS } from '../types.js';

const MAX_OCR_PAGES = 8; // a scanned PDF longer than this is only read on its first pages
const MAX_HINT_CHARS = 24000; // text sent to the model with each request
const MAX_SAVED_TEXT = 20000; // text kept on the document for search and for people to read; the store copies it often
const MIN_TEXT_LAYER_CHARS = 40; // a "text layer" shorter than this is really a scan

/** Reads documents, at most `parallel` at a time. */
export async function readDocuments(ctx, docs, { parallel = 3 } = {}) {
  const results = [];
  await eachLimited(docs, parallel, async (doc) => { results.push(await readOneDocument(ctx, doc)); });
  return results;
}

/** Runs fn over the list with at most `limit` running at once. */
export async function eachLimited(list, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < list.length) {
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
  await store.put('documents', { ...doc, status: 'reading' });
  ctx.agentEvent('intake', 'start', `Reading ${doc.fileName}`, { docId: doc.id });
  try {
    const bytes = await store.getFile(doc.fileKey);
    const ai = await ctx.getAI();
    let result;
    if (doc.kind === 'chat') result = await readChat(ctx, ai, doc);
    else if (doc.kind === 'email') result = await readEmail(ctx, ai, doc);
    else result = await readPaper(ctx, ai, doc, bytes);

    const done = { ...doc, ...result, status: 'read', error: null, readBy: readerName(ai), readAt: ctx.nowIso() };
    await store.put('documents', done);
    await ctx.log(ctx.agentActor('intake'), 'read', describe(done), { docId: doc.id });
    // Work is done and saved; now show it. The field events play on their own paced queue.
    ctx.playFields(fieldEvents(done));
    return done;
  } catch (err) {
    const failed = { ...doc, status: 'error', error: err.message };
    await store.put('documents', failed);
    const message = `Could not read ${doc.fileName}: ${err.message}`;
    ctx.agentEvent('intake', 'error', message, { docId: doc.id });
    await ctx.log(ctx.agentActor('intake'), 'error', message, { docId: doc.id });
    return failed;
  }
}

async function readPaper(ctx, ai, doc, bytes) {
  const page = await pageText(ctx, doc, bytes);
  const item = { name: doc.fileName, mime: doc.mime, kind: doc.kind, bytes };
  const textHint = page.text.slice(0, MAX_HINT_CHARS);
  const classified = (await ai.classify(item, { textHint })) || {};
  const docType = classified.docType || 'other';
  const extraction = (await ai.extract(item, docType, { textHint, pageTexts: page.pageTexts, pageImages: page.pageImages })) || {};
  const records = await ctx.load('records');
  return {
    docType,
    classifyConfidence: classified.confidence ?? 0,
    classifyReason: classified.reason || null,
    summary: extraction.summary || null,
    fields: placeFields(records.locate, extraction.fields || [], page.words),
    lines: extraction.lines || [],
    declarations: extraction.declarations || [],
    pages: page.pages,
    hasTextLayer: page.hasTextLayer,
    pageSizes: page.pageSizes,
    ocrUsed: page.ocrUsed,
    text: page.text.slice(0, MAX_SAVED_TEXT),
  };
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
    const png = await ctx.rasterize(bytes, pageNo);
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
    docType: 'whatsapp_chat', classifyConfidence: 1, pages: 0, hasTextLayer: true, fields: [], lines: [], declarations: [],
    summary: allowed ? `${total} messages, ${(insight.relevant || []).length} about shipments` : `${total} messages (reading chats is off for this house)`,
    insights: { relevant: insight.relevant || [], requests: insight.requests || [], packing: insight.packing || [] },
    refs: insight.refs || [],
    // Once read, the insights hold what matters; the full chat stays in the original _chat.txt file.
    // (A chat that failed keeps its messages, so a retry can read it again.)
    content: allowed ? { chat: { title: chat.title, messageCount: total } } : doc.content,
  };
}

async function readEmail(ctx, ai, doc) {
  const email = doc.content?.email || {};
  const insight = (await ai.readEmail(email)) || {};
  await saveRequests(ctx, doc, insight.requests || [], 'email');
  return {
    docType: 'email', classifyConfidence: 1, pages: 0, hasTextLayer: true, fields: [], lines: [], declarations: [],
    summary: `Email from ${email.from || 'unknown sender'}: ${email.subject || '(no subject)'}`,
    insights: { relevant: insight.relevant || [], requests: insight.requests || [] },
    refs: insight.refs || [],
  };
}

/** A request in a chat or email ("send the packing list for EXP/28") becomes a message for the desk and the house. */
async function saveRequests(ctx, doc, requests, channel) {
  for (const request of requests) {
    if (!request?.text) continue;
    const author = doc.source?.chatAuthor || doc.content?.email?.from || 'House';
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
