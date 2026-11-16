// Small helpers both stores (local.js and cloud-store.js) use: names, ids, copies, sorting, filters,
// safe file paths and the workspace (house settings) shape.
import { createHash, randomUUID } from 'node:crypto';

// Collection names become file names (<collection>.json), so they must be boring:
// lowercase letters, digits and _. "workspace" is taken by workspace.json.
const COLLECTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isCollectionName(name) {
  return typeof name === 'string' && COLLECTION_NAME.test(name) && name !== 'workspace';
}

export function checkCollection(name) {
  if (!isCollectionName(name)) {
    throw new Error(`Bad collection name ${JSON.stringify(name)}. Use lowercase letters, digits and _.`);
  }
  return name;
}

export function isWorkspaceId(id) {
  return typeof id === 'string' && WORKSPACE_ID.test(id);
}

export function checkWorkspaceId(id) {
  if (!isWorkspaceId(id)) throw new Error(`Bad workspace id ${JSON.stringify(id)}`);
  return id;
}

/** The id of a record being saved: the one it has (checked), or a new random one. */
export function recordId(obj) {
  const id = obj?.id;
  if (id === undefined || id === null || id === '') return randomUUID();
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  if (typeof id !== 'string' || id.length > 200 || /[\u0000-\u001f]/.test(id)) {
    throw new Error(`Bad record id ${JSON.stringify(id)}`);
  }
  return id;
}

export function nowIso() {
  return new Date().toISOString();
}

/**
 * A deep copy through JSON. Callers get their own copy, so changing it never changes the store
 * by accident, and what you save is exactly what you get back after a restart.
 */
export function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** The record as the store keeps it: a copy with id, workspaceId, createdAt and updatedAt filled in. */
export function stampRecord(obj, id, existing, workspaceId, now = nowIso()) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('put needs a plain object');
  return {
    ...copy(obj),
    id,
    workspaceId,
    createdAt: obj.createdAt || existing?.createdAt || now,
    updatedAt: now,
  };
}

/** list() filters: a function (record) => boolean, or an object of fields that must be equal. */
export function matches(record, filter) {
  if (!filter) return true;
  if (typeof filter === 'function') return Boolean(filter(record));
  return Object.entries(filter).every(([key, value]) => record[key] === value);
}

/** Oldest first, so lists come back in the same order from both stores. */
export function sortRecords(records) {
  return records.sort((a, b) => {
    const byTime = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    return byTime !== 0 ? byTime : String(a.id).localeCompare(String(b.id));
  });
}

/** Bytes for putFile: Uint8Array (Buffer is one), ArrayBuffer or a string. */
export function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (typeof bytes === 'string') return new TextEncoder().encode(bytes);
  throw new Error('putFile needs bytes (Uint8Array, Buffer, ArrayBuffer or string)');
}

// ---------- file keys ----------

/** File keys look like docs/<docId>/<fileName>. No empty, "." or ".." parts, so a key can never leave its folder. */
export function checkFileKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1000) {
    throw new Error(`Bad file key ${JSON.stringify(key)}`);
  }
  const parts = key.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Bad file key ${JSON.stringify(key)}`);
  }
  return key;
}

// Characters that are safe in file names on Mac and Windows and in Supabase Storage object names.
const SAFE_CHAR = /^[A-Za-z0-9._() -]$/;

/**
 * Turns a file key into a safe relative path (same on disk and in Supabase Storage).
 * Anything outside the safe set becomes $ plus its UTF-8 bytes in hex: "naïve.pdf" -> "na$C3$AFve.pdf".
 */
export function encodeFileKey(key) {
  return checkFileKey(key).split('/').map(encodeSegment).join('/');
}

function encodeSegment(segment) {
  let out = '';
  for (const ch of segment) out += SAFE_CHAR.test(ch) ? ch : escapeChar(ch);
  // Windows does not allow a name to end with a dot or a space.
  if (out.endsWith('.') || out.endsWith(' ')) out = out.slice(0, -1) + escapeChar(out.slice(-1));
  // Windows reserves device names like CON or NUL, even with an extension.
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(out)) out = escapeChar(out[0]) + out.slice(1);
  // Very long names break Windows paths: keep the start and add a short hash so it stays unique.
  if (out.length > 120) out = `${out.slice(0, 100)}_${sha256Hex(segment).slice(0, 16)}`;
  return out;
}

function escapeChar(ch) {
  return [...new TextEncoder().encode(ch)].map((b) => `$${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** True when two JSON values are equal, ignoring key order (the database does not keep key order). */
export function sameJson(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// ---------- workspace (house settings) ----------

function text(value) {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A list of unique non-empty strings. Also accepts "a, b; c" or one item per line. */
function textList(value, fallback = []) {
  if (value === undefined || value === null) return [...fallback];
  const items = Array.isArray(value) ? value : String(value).split(/[,;\n]/);
  return [...new Set(items.map(text).filter(Boolean))];
}

/**
 * Fills in every workspace field with a sensible default. Unknown extra fields are kept, so other
 * modules can store their own settings on the workspace.
 */
export function normalizeWorkspace(input = {}) {
  const src = isPlainObject(input) ? input : {};
  const name = text(src.name) || 'My house';
  const legalEntity = text(src.legalEntity);
  const city = text(src.city);
  const country = text(src.country);
  const letterhead = isPlainObject(src.letterhead) ? src.letterhead : {};
  const permissions = isPlainObject(src.permissions) ? src.permissions : {};
  return {
    ...src,
    id: src.id ? String(src.id) : src.id,
    name,
    legalEntity,
    country,
    city,
    role: text(src.role) || 'exporter', // exporter, importer, manufacturer or trader
    commodities: textList(src.commodities, ['Diamonds']),
    contactEmails: textList(src.contactEmails).map((e) => e.toLowerCase()),
    emailDomains: textList(src.emailDomains).map((d) => d.toLowerCase().replace(/^@/, '')),
    whatsappNumbers: textList(src.whatsappNumbers),
    destinations: textList(src.destinations),
    letterhead: {
      ...letterhead,
      companyName: text(letterhead.companyName) || legalEntity || name,
      address: text(letterhead.address),
      cityCountry: text(letterhead.cityCountry) || [city, country].filter(Boolean).join(', '),
      eori: text(letterhead.eori),
      iec: text(letterhead.iec),
      gstin: text(letterhead.gstin),
      phone: text(letterhead.phone),
      email: text(letterhead.email),
    },
    permissions: {
      ...permissions,
      searchMailbox: bool(permissions.searchMailbox, true),
      readWhatsApp: bool(permissions.readWhatsApp, true),
      draftRequests: bool(permissions.draftRequests, true),
      ofacScreen: bool(permissions.ofacScreen, true),
    },
    deskReview: bool(src.deskReview, false),
    autopilot: bool(src.autopilot, true),
    environment: src.environment === 'live' ? 'live' : 'sandbox',
    createdAt: text(src.createdAt) || null,
    updatedAt: text(src.updatedAt) || null,
  };
}

/** A brand-new workspace from the onboarding profile. The house name is the only required field. */
export function newWorkspace(profile = {}, now = nowIso()) {
  if (!text(profile?.name)) throw new Error('A house name is required.');
  const id = profile.id === undefined || profile.id === null || profile.id === '' ? randomUUID() : checkWorkspaceId(profile.id);
  return normalizeWorkspace({ ...copy(profile), id, createdAt: now, updatedAt: now });
}

/**
 * Applies a settings change. letterhead and permissions merge one level deep, so
 * { permissions: { ofacScreen: false } } keeps the other permissions as they were.
 */
export function applyWorkspacePatch(current, patch = {}, now = nowIso()) {
  const changes = isPlainObject(patch) ? copy(patch) : {};
  const merged = { ...current, ...changes, id: current.id, createdAt: current.createdAt, updatedAt: now };
  for (const key of ['letterhead', 'permissions']) {
    if (isPlainObject(changes[key])) merged[key] = { ...current[key], ...changes[key] };
  }
  return normalizeWorkspace(merged);
}
