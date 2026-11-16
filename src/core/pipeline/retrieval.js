// Retrieval agent: takes files in (drop, folder, mailbox, WhatsApp export, sample), unpacks them,
// skips anything already on file and stores the rest as new documents for Intake to read.
import { newId, toBytes } from './context.js';
import { safeFileName } from './files.js';

export const MAX_RETRIES = 3; // the worker reads a failed document again at most this many times
const adding = new WeakMap(); // store -> Map(sha256 -> Promise of the document id) for files being added right now

/**
 * files: [{ name, bytes, source, by?, error? }] -> { documentIds, duplicates: [{ name, docId }], failed: [{ name, error }] }
 * quiet: the mailbox and folder loops pass it, so a file seen again is not logged one line at a time.
 * error: the file is not opened at all; it is kept as a paper that could not be read, with this reason (the worker
 * passes it for a file that stopped the app last time).
 */
export async function addFiles(ctx, files, { quiet = false } = {}) {
  const ingest = await ctx.load('ingest');
  const result = { documentIds: [], duplicates: [], failed: [] };
  for (const file of files || []) {
    const source = { kind: 'upload', receivedAt: ctx.nowIso(), ...(file.source || {}) };
    let items;
    try {
      items = file.error ? [unopened(ingest, file)] : (await ingest.ingestFile({ name: file.name, bytes: toBytes(file.bytes), source })).items || [];
    } catch (err) {
      // One broken file (a damaged zip, say) must not stop the rest of the drop.
      result.failed.push({ name: file.name, error: err.message });
      await ctx.log(ctx.agentActor('retrieval'), 'error', `Could not open ${file.name}: ${err.message}`);
      ctx.agentEvent('retrieval', 'error', `Could not open ${file.name}: ${err.message}`);
      continue;
    }
    // Lets an attachment point at the email or WhatsApp chat it came in.
    const batch = { idsByName: new Map(), chatId: null };
    for (const item of items) {
      let added;
      try {
        added = await addItem(ctx, ingest, item, source, batch, { by: file.by, quiet });
      } catch (err) {
        // A file the store refuses (too big for a shared house, say) must not stop the rest of the drop.
        result.failed.push({ name: item.name, error: err.message });
        await ctx.log(ctx.agentActor('retrieval'), 'error', `Could not add ${item.name}: ${err.message}`);
        ctx.agentEvent('retrieval', 'error', `Could not add ${item.name}: ${err.message}`);
        continue;
      }
      if (added.duplicate) result.duplicates.push({ name: item.name, docId: added.docId });
      else result.documentIds.push(added.docId);
    }
  }
  return result;
}

/**
 * Adds one file, unless it is already on file. Two loops adding the same file at the same moment (the mailbox and
 * a "Check now", say) must not store it twice: the second waits for the first and finds its document.
 */
async function addItem(ctx, ingest, item, fileSource, batch, options) {
  const bytes = toBytes(item.bytes);
  const hash = item.sha256 || ingest.sha256(bytes);
  if (!adding.has(ctx.store)) adding.set(ctx.store, new Map());
  const busy = adding.get(ctx.store);
  while (busy.has(hash)) await busy.get(hash).catch(() => null);
  const work = addNewItem(ctx, item, bytes, hash, fileSource, batch, options);
  busy.set(hash, work);
  try {
    return await work;
  } finally {
    busy.delete(hash);
  }
}

async function addNewItem(ctx, item, bytes, hash, fileSource, batch, { by, quiet }) {
  const { store } = ctx;
  const existing = (await store.list('documents', (d) => d.sha256 === hash))[0];
  if (existing) {
    remember(batch, item, existing.id);
    if (!quiet) {
      const detail = `${item.name} is already on file`;
      await ctx.log(ctx.agentActor('retrieval'), 'skipped', detail, { docId: existing.id, shipmentId: existing.shipmentId });
      ctx.agentEvent('retrieval', 'done', detail, { docId: existing.id });
    }
    return { duplicate: true, docId: existing.id };
  }

  const id = newId('doc');
  const fileKey = `docs/${id}/${safeFileName(item.name)}`;
  await store.putFile(fileKey, bytes, item.mime || 'application/octet-stream');
  const source = { ...fileSource, ...(item.source || {}) };
  if (fileSource.kind === 'sample') source.sample = true; // a sample chat keeps kind 'whatsapp' but is still a sample
  const doc = {
    id,
    fileName: item.name,
    mime: item.mime || 'application/octet-stream',
    kind: item.kind || 'other',
    size: bytes.length,
    sha256: hash,
    fileKey,
    source,
    parentId: parentIdOf(item, batch),
    pages: 0,
    hasTextLayer: false,
    docType: item.kind === 'chat' ? 'whatsapp_chat' : item.kind === 'email' ? 'email' : 'other',
    classifyConfidence: 0,
    fields: [],
    lines: [],
    declarations: [],
    shipmentId: null,
    // A file ingest could not open (a damaged zip, say) is kept with its reason and never retried.
    status: item.error ? 'error' : 'new',
    error: item.error || null,
    retries: item.error ? MAX_RETRIES : 0,
    content: contentOf(item),
  };
  await store.put('documents', doc);
  remember(batch, item, id);
  await ctx.usage('upload', { docId: id, sourceKind: source.kind }, by);
  await ctx.log(ctx.agentActor('retrieval'), 'received', `${item.name} from ${sourceLabel(source)}`, { docId: id });
  ctx.agentEvent('retrieval', 'read', `Received ${item.name}`, { docId: id });
  if (item.error) {
    await ctx.log(ctx.agentActor('retrieval'), 'error', `${item.name}: ${item.error}`, { docId: id });
    ctx.agentEvent('retrieval', 'error', `${item.name}: ${item.error}`, { docId: id });
  }
  return { duplicate: false, docId: id };
}

/** A file kept as it is, unopened, as a paper that could not be read (reason: file.error). */
function unopened(ingest, file) {
  const bytes = toBytes(file.bytes);
  const mime = ingest.detectMime(file.name, bytes);
  return { name: file.name, mime, kind: ingest.kindForMime(mime), bytes, error: String(file.error) };
}

/** The parsed parts Intake needs later (chat messages, email text, sheet text), kept with the document. */
function contentOf(item) {
  const content = {};
  if (item.chat) content.chat = item.chat;
  if (item.email) content.email = { ...item.email, text: String(item.email.text || '').slice(0, 100000) };
  if (item.sheet) content.sheet = { text: String(item.sheet.text || '').slice(0, 100000) };
  if (item.text) content.text = String(item.text).slice(0, 100000);
  return content;
}

function remember(batch, item, docId) {
  batch.idsByName.set(item.name, docId);
  if (item.kind === 'chat') batch.chatId = docId;
}

function parentIdOf(item, batch) {
  const parent = typeof item.parent === 'string' ? item.parent : item.parent?.name;
  if (parent && batch.idsByName.has(parent)) return batch.idsByName.get(parent);
  // In a WhatsApp export the parent is the zip, which is not a document: point at the chat instead.
  if (item.kind !== 'chat' && item.source?.kind === 'whatsapp' && batch.chatId) return batch.chatId;
  return null;
}

export function sourceLabel(source = {}) {
  switch (source.kind) {
    case 'folder': return `the watched folder${source.ref ? ` (${source.ref})` : ''}`;
    case 'email': return `an email${source.from ? ` from ${source.from}` : ''}`;
    case 'whatsapp': return `a WhatsApp chat${source.chatAuthor ? ` (${source.chatAuthor})` : ''}`;
    case 'forward': return 'a forwarded email';
    case 'sample': return 'the SAMPLE shipment';
    case 'generated': return 'the agents';
    default: return 'an upload';
  }
}

/**
 * Stores a PDF the agents made (a packing list draft) as an already-read document of the shipment,
 * so Records and the rules see it like any other paper.
 */
export async function addGeneratedDocument(ctx, { name, bytes, shipment, docType, fields = [], lines = [], summary = null, sources = [] }) {
  const { store } = ctx;
  const data = toBytes(bytes);
  const ingest = await ctx.load('ingest');
  const hash = ingest.sha256(data);
  const existing = (await store.list('documents', (d) => d.sha256 === hash))[0];
  if (existing) return existing;
  const id = newId('doc');
  const fileKey = `docs/${id}/${safeFileName(name)}`;
  await store.putFile(fileKey, data, 'application/pdf');
  const doc = {
    id, fileName: name, mime: 'application/pdf', kind: 'pdf', size: data.length, sha256: hash, fileKey,
    source: { kind: 'generated', ref: shipment?.ref || null, receivedAt: ctx.nowIso() },
    parentId: null, pages: 1, hasTextLayer: true, docType, classifyConfidence: 1, summary,
    fields, lines, declarations: [], sources, shipmentId: shipment?.id || null,
    status: 'read', readBy: 'Paperwork', readAt: ctx.nowIso(), retries: 0, content: {},
  };
  await store.put('documents', doc);
  await ctx.log(ctx.agentActor('paperwork'), 'drafted', `${name} (${lines.length} lines)`, { docId: id, shipmentId: shipment?.id });
  return doc;
}
