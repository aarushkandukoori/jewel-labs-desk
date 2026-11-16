// The AI layer. createAI() returns the object the agents use to read papers, chats and emails, and to route
// what a clerk types under "Tell the agents".
//
// Modes:
//   direct  the house's own OpenAI key, straight to OpenAI
//   proxy   the Jewel Labs proxy, with the signed-in user's token (no key on the machine)
//   off     no AI: the offline reader (regular expressions) does the work, less accurately
//   mock    for tests: mockHandler(task, args) returns the answer; task is 'classify', 'extract', 'readChat',
//           'readEmail', 'route' or 'draftPackingList'. Return undefined to use the offline reader instead.
//
// Every method falls back to the offline reader when the AI is off or a call fails, so the agents keep working.
// The last AI problem is kept in ai.lastError ({ code, message, at }) for the app to show.

import { createClient, AIError, isFileRejection, NO_KEY_MESSAGE } from './client.js';
import {
  EXTRACTION_SCHEMA, CLASSIFY_SCHEMA, CHAT_SCHEMA, EMAIL_SCHEMA, ROUTE_SCHEMA, PACKING_SCHEMA, PING_SCHEMA,
} from './schemas.js';
import * as prompts from './prompts.js';
import { classifyByRules, familyOf } from './classify.js';
import { readDocument } from './heuristics.js';
import {
  isFluff, readChatOffline, readEmailOffline, routeOffline, draftPackingListOffline, newPartOfEmail,
} from './conversation.js';
import { normalizeExtraction, normalizeClassification, normalizeRoute, normalizeLine, crossCheck } from './normalize.js';
import { capText, containsLoose, squash, oneLine, plainCopy } from './text.js';

export { AIError } from './client.js';

// Input caps: enough for real papers, small enough to keep calls fast and cheap.
const LIMITS = {
  textHint: 60_000, // characters of text layer sent with a paper (about 15k tokens)
  textHintWithFile: 30_000, // less when the PDF itself goes along
  classifyText: 6_000,
  pdfBytes: 20 * 1024 * 1024,
  imageBytes: 15 * 1024 * 1024,
  pageImages: 8,
  chatChars: 24_000, // per chunk of a long chat
  emailChars: 20_000,
  materialLines: 400,
  shipments: 30,
  questions: 15,
};
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function createAI(options = {}) {
  const { mode = 'off', apiKey = '', proxyUrl = '', getAccessToken = null, mockHandler = null } = options;
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const canCall = (mode === 'direct' && Boolean(apiKey)) || (mode === 'proxy' && Boolean(proxyUrl && getAccessToken));
  const client = canCall
    ? createClient({
      mode,
      apiKey,
      proxyUrl,
      getAccessToken,
      model: options.model,
      models: options.models,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      tries: options.tries,
      retryBaseMs: options.retryBaseMs,
      onUsage: (usage) => {
        totals.calls += 1;
        totals.inputTokens += usage.prompt_tokens || 0;
        totals.outputTokens += usage.completion_tokens || 0;
      },
    })
    : null;
  let filesRejected = false; // set once the API refuses PDF file parts; then pages go as images and text

  const ai = {
    mode,
    available: Boolean(client) || mode === 'mock',
    get model() {
      if (client) return client.model;
      return mode === 'mock' ? 'mock' : 'offline';
    },
    lastError: null,
    classify,
    extract,
    readChat,
    readEmail,
    route,
    draftPackingList,
    usage,
    check,
  };
  if (mode === 'direct' && !apiKey) ai.lastError = { code: 'no_key', message: NO_KEY_MESSAGE, at: null };
  if (mode === 'proxy' && !client) ai.lastError = { code: 'signed_out', message: 'Sign in to Jewel Labs to use the AI.', at: null };

  function remember(err) {
    ai.lastError = { code: err?.code || 'error', message: err?.message || String(err), at: new Date().toISOString() };
  }

  async function fromMock(task, args) {
    if (mode !== 'mock' || typeof mockHandler !== 'function') return undefined;
    totals.calls += 1;
    return mockHandler(task, args);
  }

  // ---- documents ----

  /** The paper itself for the model: an image, the PDF as a file part, or page images. */
  function documentParts(item, { pageImages = [], detail = 'high', maxImages = LIMITS.pageImages } = {}) {
    const bytes = item?.bytes;
    const mime = item?.mime === 'image/jpg' ? 'image/jpeg' : item?.mime;
    if (item?.kind === 'image' && bytes?.length && bytes.length <= LIMITS.imageBytes && IMAGE_TYPES.includes(mime)) {
      return [imagePart(`data:${mime};base64,${toBase64(bytes)}`, detail)];
    }
    if (item?.kind === 'pdf' && bytes?.length && !filesRejected && bytes.length <= LIMITS.pdfBytes) {
      return [{ type: 'file', file: { filename: pdfName(item.name), file_data: `data:application/pdf;base64,${toBase64(bytes)}` } }];
    }
    return (pageImages || []).slice(0, maxImages).map((url) => imagePart(url, detail));
  }

  /** Ask about a paper. If the API refuses the PDF file part, remember that and ask again with page images. */
  async function askDocument({ system, text, item, pageImages, schema, name, maxTokens, detail }) {
    const send = (parts) => client.json({
      schema,
      name,
      maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: [{ type: 'text', text }, ...parts] }],
    });
    const parts = documentParts(item, { pageImages, detail });
    try {
      return await send(parts);
    } catch (err) {
      if (!parts.some((p) => p.type === 'file') || !isFileRejection(err)) throw err;
      filesRejected = true;
      return send(documentParts(item, { pageImages, detail }));
    }
  }

  async function classify(item, opts = {}) {
    const text = String(opts.textHint || item?.text || item?.sheet?.text || '');
    const guess = classifyByRules({ name: item?.name, text, kind: item?.kind });
    if (guess.confidence >= 0.85) return guess; // cheap and sure enough: no AI call
    const mocked = await fromMock('classify', { item, options: opts, guess });
    if (mocked) return normalizeClassification(mocked, guess);
    if (!client) return guess;
    try {
      const prompt = prompts.classifyPrompt({ fileName: item?.name, textHint: capText(text, LIMITS.classifyText), guess });
      const hasText = Boolean(text.trim()); // with text the words are enough; without, the model looks at the paper
      const { value } = await askDocument({
        system: prompts.CLASSIFY_SYSTEM, text: prompt, item: hasText ? null : item,
        pageImages: hasText ? [] : (opts.pageImages || []).slice(0, 1),
        schema: CLASSIFY_SCHEMA, name: 'classification', maxTokens: 400, detail: 'low',
      });
      return normalizeClassification(value, guess);
    } catch (err) {
      remember(err);
      return { ...guess, reason: `${guess.reason} (AI unavailable)` };
    }
  }

  async function extract(item, docType = 'other', opts = {}) {
    const text = documentText(item, opts);
    const offline = readDocument({ text: text.plain, pageTexts: opts.pageTexts, docType, sheet: item?.sheet });
    const mocked = await fromMock('extract', { item, docType, options: opts });
    if (mocked) return { ...normalizeExtraction(mocked, docType), readBy: 'mock', warnings: [] };
    if (!client) return { ...offline, warnings: [] };
    try {
      const sendsFile = item?.kind === 'pdf' && !filesRejected && item?.bytes?.length > 0 && item.bytes.length <= LIMITS.pdfBytes;
      const hint = capText(text.marked, sendsFile ? LIMITS.textHintWithFile : LIMITS.textHint);
      if (!hint.trim() && !documentParts(item, opts).length) {
        throw new AIError('no_content', 'Nothing to read: no text layer and no page image.');
      }
      const prompt = prompts.extractPrompt({ fileName: item?.name, docType, family: familyOf(docType), textHint: hint, textSource: opts.textSource });
      const { value, model } = await askDocument({
        system: prompts.READER_SYSTEM, text: prompt, item, pageImages: opts.pageImages,
        schema: EXTRACTION_SCHEMA, name: 'extraction', maxTokens: 16_000, detail: 'high',
      });
      const result = normalizeExtraction(value, docType);
      // Quotes are checked against a real text layer only. OCR text has its own mistakes; page images come
      // only with scans, so they mean the text is OCR unless the caller says otherwise.
      const ocr = opts.textSource ? opts.textSource === 'ocr' : item?.kind === 'image' || Boolean(opts.pageImages?.length);
      const verifyQuotes = !ocr;
      const warnings = crossCheck(result, offline, { text: text.plain, verifyQuotes });
      return { ...result, readBy: `ai:${model}`, warnings };
    } catch (err) {
      remember(err);
      return { ...offline, warnings: [`Read offline: ${err.message}`] };
    }
  }

  // ---- chats and emails ----

  async function readChat(chat) {
    const offline = readChatOffline(chat);
    const mocked = await fromMock('readChat', { chat });
    if (mocked) return { relevant: [], requests: [], packing: [], refs: [], ...mocked };
    if (!client) return offline;
    const original = chat?.messages || [];
    const kept = original.map((m, index) => ({ ...m, index })).filter((m) => !isFluff(m)); // clear the fluff
    if (!kept.length) return offline;
    try {
      const result = { relevant: [], requests: [], packing: [], refs: [] };
      for (const chunk of chunkMessages(kept, LIMITS.chatChars)) {
        const lines = chunk.map((m) => `#${m.index} [${m.at || ''}] ${m.author || 'system'}: ${oneLine(m.text)}${m.attachment ? ` <file: ${m.attachment}>` : ''}`);
        const { value } = await client.json({
          schema: CHAT_SCHEMA,
          name: 'chat_reading',
          maxTokens: 8_000,
          messages: [{ role: 'system', content: prompts.CHAT_SYSTEM }, { role: 'user', content: prompts.chatPrompt({ title: chat?.title, lines }) }],
        });
        mergeChatAnswer(result, value, original);
      }
      for (const group of result.packing) group.lines.forEach((line, i) => { line.lineNo = i + 1; });
      return result;
    } catch (err) {
      remember(err);
      return { ...offline, warnings: [`Read offline: ${err.message}`] };
    }
  }

  async function readEmail(email) {
    const offline = readEmailOffline(email);
    const mocked = await fromMock('readEmail', { email });
    if (mocked) return { relevant: [], requests: [], refs: [], ...mocked };
    if (!client) return offline;
    const body = capText(newPartOfEmail(email?.text), LIMITS.emailChars);
    if (!body.trim()) return offline;
    try {
      const { value } = await client.json({
        schema: EMAIL_SCHEMA,
        name: 'email_reading',
        maxTokens: 4_000,
        messages: [{ role: 'system', content: prompts.EMAIL_SYSTEM }, { role: 'user', content: prompts.emailPrompt({ email, body }) }],
      });
      // Keep only what is really in the email: the model must quote, not paraphrase or invent.
      const source = `${email?.subject || ''}\n${body}`;
      const inEmail = (s) => Boolean(s) && containsLoose(source, s);
      return {
        relevant: value.relevant.filter((r) => inEmail(r.text))
          .map((r) => ({ at: email?.date ?? null, author: email?.from ?? null, text: oneLine(r.text), why: oneLine(r.why) })),
        requests: value.requests.filter((r) => inEmail(r.text))
          .map((r) => ({ text: oneLine(r.text), ref: inEmail(r.ref) ? oneLine(r.ref) : null })),
        refs: uniqueLoose(value.refs.filter(inEmail).map(oneLine)),
        packing: offline.packing,
      };
    } catch (err) {
      remember(err);
      return { ...offline, warnings: [`Read offline: ${err.message}`] };
    }
  }

  // ---- "Tell the agents" ----

  async function route(text, context = {}) {
    const shipments = context.shipments || [];
    const openQuestions = context.openQuestions || [];
    const offline = routeOffline(text, { shipments, openQuestions });
    const mocked = await fromMock('route', { text, shipments, openQuestions });
    if (mocked) return normalizeRoute(mocked, { text, shipments, fallback: offline });
    if (!client) return offline;
    try {
      const refOf = (id) => shipments.find((s) => s.id === id)?.ref || null;
      const list = recentFirst(shipments).slice(0, LIMITS.shipments).map(shipmentSummary);
      const questions = openQuestions
        .filter((q) => (q.status || 'open') === 'open')
        .slice(0, LIMITS.questions)
        .map((q) => ({ shipment: refOf(q.shipmentId), text: oneLine(q.text) }));
      const { value } = await client.json({
        schema: ROUTE_SCHEMA,
        name: 'route',
        maxTokens: 800,
        messages: [{ role: 'system', content: prompts.ROUTE_SYSTEM }, { role: 'user', content: prompts.routePrompt({ text, shipments: list, questions }) }],
      });
      return normalizeRoute(value, { text, shipments, fallback: offline });
    } catch (err) {
      remember(err);
      return offline;
    }
  }

  async function draftPackingList(input = {}) {
    const offline = draftPackingListOffline(input);
    const mocked = await fromMock('draftPackingList', input);
    if (mocked) return { lines: [], sources: [], notes: '', ...mocked };
    if (!client) return offline;
    const material = buildMaterial(input);
    if (!material.lines.length) return offline;
    try {
      const { value } = await client.json({
        schema: PACKING_SCHEMA,
        name: 'packing_list',
        maxTokens: 12_000,
        messages: [
          { role: 'system', content: prompts.PACKING_SYSTEM },
          { role: 'user', content: prompts.packingPrompt({ shipment: input.shipment, material: material.lines }) },
        ],
      });
      const lines = [];
      const sources = [];
      let leftOut = 0;
      for (const raw of value.lines) {
        const source = material.byTag[raw.source];
        const line = normalizeLine(raw, lines.length);
        // Never invent stones: the line's report number (or carat) must be in the material it cites.
        if (!source || !backedBy(line, source.text)) {
          leftOut += 1;
          continue;
        }
        if (line.reportNumber && lines.some((l) => l.reportNumber === line.reportNumber)) continue;
        line.lineNo = lines.length + 1;
        if (!line.quote || !containsLoose(source.text, line.quote)) line.quote = source.quote;
        lines.push(line);
        sources.push({ kind: source.kind, ref: source.ref, quote: line.quote, ...(source.docId ? { docId: source.docId } : {}) });
      }
      let notes = plainCopy(oneLine(value.notes));
      if (leftOut) notes += ` ${leftOut} line${leftOut === 1 ? ' was' : 's were'} left out: not found in the chat, emails or papers.`;
      return { lines, sources, notes: notes.trim() };
    } catch (err) {
      remember(err);
      return offline;
    }
  }

  // ---- status ----

  function usage() {
    return { ...totals };
  }

  /** A tiny call to confirm the key or sign-in works (Settings "Test" button). */
  async function check() {
    if (mode === 'mock') return { ok: true, mode, model: 'mock', message: 'Mock AI for tests.' };
    if (!client) {
      return { ok: false, mode, model: ai.model, code: ai.lastError?.code || 'off', message: ai.lastError?.message || 'The AI is off. The offline reader is used.' };
    }
    try {
      const { model } = await client.json({
        schema: PING_SCHEMA, name: 'ping', maxTokens: 300, messages: [{ role: 'user', content: 'Reply with {"ok": true}.' }],
      });
      return { ok: true, mode, model, message: `Connected. The agents use ${model}.` };
    } catch (err) {
      remember(err);
      return { ok: false, mode, model: ai.model, code: err.code, message: err.message };
    }
  }

  return ai;
}

// ---------------------------------------------------------------- helpers

function imagePart(url, detail) {
  return { type: 'image_url', image_url: { url, detail } };
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function pdfName(name) {
  const base = String(name || 'document.pdf').split(/[\\/]/).pop();
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

/** The paper's text: plain (for checks; pages split by \f) and marked with "--- Page N ---" for the model. */
function documentText(item, opts) {
  const pageTexts = Array.isArray(opts.pageTexts) && opts.pageTexts.length ? opts.pageTexts.map((p) => String(p || '')) : null;
  let plain = pageTexts ? pageTexts.join('\f') : String(opts.textHint || '');
  if (!plain) {
    if (item?.kind === 'sheet') plain = item.sheet?.text || '';
    else if (item?.kind === 'email') plain = emailText(item.email);
    else if (item?.kind === 'chat') plain = (item.chat?.messages || []).map((m) => `${m.author || ''}: ${m.text || ''}`).join('\n');
    else plain = String(item?.text || '');
  }
  const pages = plain.split('\f');
  const marked = pages.length > 1 ? pages.map((page, i) => `--- Page ${i + 1} ---\n${page}`).join('\n') : plain;
  return { plain, marked };
}

function emailText(email) {
  if (!email) return '';
  return `From: ${email.from || ''}\nTo: ${email.to || ''}\nSubject: ${email.subject || ''}\nDate: ${email.date || ''}\n\n${email.text || ''}`;
}

/** Split a long chat into pieces the model reads one at a time. */
function chunkMessages(messages, maxChars) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const m of messages) {
    const length = String(m.text || '').length + 40;
    if (current.length && size + length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(m);
    size += length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Add one chunk's answer to the chat result. Text, author and time are copied from the original message;
 * refs and stones must really be in the chat.
 */
function mergeChatAnswer(result, value, original) {
  const messageAt = (i) => (Number.isInteger(i) && original[i] ? original[i] : null);
  const allText = original.map((m) => m.text || '').join('\n');
  const typed = (ref) => Boolean(ref) && containsLoose(allText, ref);
  for (const r of value.relevant || []) {
    const m = messageAt(r.index);
    if (!m || result.relevant.some((x) => x.index === r.index)) continue;
    result.relevant.push({ index: r.index, at: m.at ?? null, author: m.author ?? null, text: oneLine(m.text) || String(m.attachment || ''), why: oneLine(r.why) });
  }
  for (const r of value.requests || []) {
    const m = messageAt(r.index);
    if (!m || result.requests.some((x) => x.index === r.index)) continue;
    result.requests.push({ index: r.index, text: oneLine(m.text), ref: typed(r.ref) ? oneLine(r.ref) : null, at: m.at ?? null, author: m.author ?? null });
  }
  for (const p of value.packing || []) {
    const m = messageAt(p.index);
    if (!m) continue;
    const lines = (p.lines || []).map((line, i) => normalizeLine(line, i)).filter((line) => backedBy(line, m.text));
    if (!lines.length) continue;
    for (const line of lines) if (!line.quote || !containsLoose(m.text, line.quote)) line.quote = oneLine(m.text);
    const ref = typed(p.ref) ? oneLine(p.ref) : null;
    let group = result.packing.find((g) => g.ref === ref);
    if (!group) {
      group = { ref, lines: [] };
      result.packing.push(group);
    }
    group.lines.push(...lines);
  }
  result.refs = uniqueLoose([...result.refs, ...(value.refs || []).filter(typed).map(oneLine)]);
}

/** True when the line's report number, or else its carat weight, is written in the text. */
function backedBy(line, text) {
  const hay = squash(text);
  if (line.reportNumber) return hay.includes(squash(line.reportNumber));
  if (line.carat !== null && line.carat !== undefined) return hay.includes(String(line.carat)) || hay.includes(line.carat.toFixed(2));
  return false;
}

/** Tagged material for the packing list draft: [C1] chat lines, [E1-2] email lines, [D2-4] lines of papers. */
function buildMaterial({ chatLines = [], emails = [], documents = [] }) {
  const lines = [];
  const byTag = {};
  const add = (tag, entry, display) => {
    if (lines.length >= LIMITS.materialLines) return;
    byTag[tag] = entry;
    lines.push(`[${tag}] ${display}`);
  };
  let c = 0;
  for (const message of chatLines) {
    const ref = [message.author, message.at].filter(Boolean).join(', ') || message.ref || 'chat';
    // Packing notes from readChat carry stone lines already read from the chat; use those lines as the material.
    const pieces = Array.isArray(message.lines) && message.lines.length
      ? message.lines.map((line) => oneLine(line.quote || describeLine(line)))
      : String(message.text || '').split(/\r?\n/).map(oneLine);
    for (const piece of pieces.filter(Boolean)) {
      c += 1;
      add(`C${c}`, { kind: 'chat', ref, text: piece, quote: piece }, `${message.author ? `${message.author}: ` : ''}${piece}`);
    }
  }
  emails.forEach((email, e) => {
    newPartOfEmail(email.text).split(/\r?\n/).map(oneLine).filter(Boolean).forEach((piece, i) => {
      add(`E${e + 1}-${i + 1}`, { kind: 'email', ref: email.subject || email.from || 'email', text: piece, quote: piece }, piece);
    });
  });
  documents.forEach((doc, d) => {
    (doc.lines || []).forEach((line, i) => {
      const shown = describeLine(line);
      const name = doc.fileName || doc.id || `paper ${d + 1}`;
      add(`D${d + 1}-${i + 1}`, {
        kind: 'document',
        ref: `${name}${line.lineNo ? ` line ${line.lineNo}` : ''}`,
        text: `${shown} ${line.quote || ''}`,
        quote: line.quote || shown,
        docId: doc.id || null,
      }, `${name} (${doc.docType || 'paper'}): ${shown}`);
    });
  });
  return { lines, byTag };
}

function describeLine(line) {
  return [
    line.reportNumber && `report ${line.reportNumber}`,
    line.lab,
    line.shape,
    line.carat !== null && line.carat !== undefined && `${line.carat} ct`,
    line.color,
    line.clarity,
    line.pieces !== null && line.pieces !== undefined && `${line.pieces} pcs`,
    line.growth,
  ].filter(Boolean).join(' | ');
}

function recentFirst(shipments) {
  const time = (s) => String(s.updatedAt || s.createdAt || '');
  return [...shipments].sort((a, b) => time(b).localeCompare(time(a)));
}

function shipmentSummary(s) {
  return {
    ref: s.ref,
    invoice: s.invoiceNumber || null,
    shippingBill: s.shippingBillNumber || null,
    hawb: s.hawb || null,
    status: s.status || null,
    destination: s.destinationCountry || null,
    consignee: (typeof s.consignee === 'string' ? s.consignee : s.consignee?.name) || null,
    goods: s.goods?.nature || null,
    updated: s.updatedAt || s.createdAt || null,
    documents: (s.documentIds || []).length,
    needs: (s.required || []).map((r) => r.kind),
  };
}

function uniqueLoose(list) {
  const out = [];
  for (const item of list) if (item && !out.some((x) => squash(x) === squash(item))) out.push(item);
  return out;
}
