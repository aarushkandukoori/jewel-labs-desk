// Pure helpers for the cloud: database rows <-> app objects, Supabase errors, Realtime payloads.
// No network here, so every function is unit tested on its own (test/unit/store.test.js).
import { copy, newWorkspace, normalizeWorkspace } from './shared.js';

export const NETWORK_MESSAGE = 'Could not reach Jewel Labs. Check your internet connection.';

/** The database's jsonb refuses the NUL character and broken UTF-16, which PDF text can contain. Clean them out. */
export function cleanForPostgres(value) {
  if (typeof value === 'string') return cleanString(value);
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : cleanForPostgres(item)));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[cleanString(key)] = cleanForPostgres(item);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function cleanString(text) {
  return text.toWellFormed().replaceAll('\u0000', '');
}

/** One row of the "records" table for a record of a collection. */
export function recordToRow(workspaceId, collection, record) {
  return { workspace_id: workspaceId, collection, id: String(record.id), data: cleanForPostgres(record) };
}

/** The record stored in a "records" row. */
export function rowToRecord(row) {
  const data = isPlainObject(row?.data) ? row.data : {};
  return { ...data, id: String(row.id), workspaceId: row.workspace_id || data.workspaceId };
}

/** A workspace from a "workspaces" row (name and environment are columns; everything else is in data). */
export function workspaceFromRow(row) {
  const data = isPlainObject(row?.data) ? row.data : {};
  return normalizeWorkspace({
    ...data,
    id: row.id,
    name: row.name,
    environment: row.environment,
    createdAt: row.created_at || data.createdAt || null,
    createdBy: row.created_by || null,
    updatedAt: data.updatedAt || row.updated_at || null,
  });
}

/** The parts of a workspace the server stores: { name, environment, data }. */
export function workspaceToRow(workspace) {
  const { id, name, environment, createdAt, createdBy, myRole, ...data } = workspace;
  return { name, environment, data: cleanForPostgres(data) };
}

/** What create_house receives: the normalized profile without the fields the server sets itself. */
export function housePayload(profile) {
  const { id, createdAt, createdBy, myRole, ...payload } = newWorkspace({ ...profile, id: undefined });
  return cleanForPostgres(payload);
}

/**
 * What update_house receives for a settings change: only the top-level keys that changed, with letterhead and
 * permissions sent whole (already merged), so two people changing different settings do not undo each other.
 */
export function workspacePatchForServer(merged, patch = {}) {
  const out = { updatedAt: merged.updatedAt };
  for (const key of Object.keys(patch || {})) {
    if (!['id', 'createdAt', 'createdBy', 'myRole'].includes(key)) out[key] = copy(merged[key]);
  }
  return cleanForPostgres(out);
}

/**
 * Turns a Supabase Realtime postgres_changes payload for "records" into { type: 'put'|'remove', row, incomplete }.
 * Realtime drops big values from large rows (and lists the problem in errors); then the row must be fetched.
 */
export function recordEventFromPayload(payload) {
  if (payload?.eventType === 'DELETE') return { type: 'remove', row: payload.old || null, incomplete: false };
  const row = payload?.new || null;
  const incomplete = Boolean(payload?.errors?.length) || !row || row.data === undefined || row.data === null;
  return { type: 'put', row, incomplete };
}

/** True for errors worth trying again later: no answer at all, timeouts, rate limits, expired sign-in, server errors. */
export function isRetryable(status) {
  if (!status) return true;
  if (status === 401 || status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

/** An Error for a failed Supabase database call ({ message, code, details } plus the HTTP status). */
export function toCloudError(error, status) {
  const err = new Error(error?.message || 'Cloud request failed');
  err.code = error?.code || null;
  err.status = status || 0;
  err.details = error?.details || null;
  err.retryable = isRetryable(err.status);
  return err;
}

/** An Error for a failed Supabase Storage call. Missing files get code ENOENT. */
export function toStorageError(error) {
  const status = Number(error?.status || error?.statusCode || 0) || 0;
  const missing = error?.statusCode === '404' || status === 404 || /not.?found/i.test(String(error?.message || ''));
  const err = new Error(error?.message || 'Cloud file request failed');
  err.status = missing ? 404 : status;
  err.code = missing ? 'ENOENT' : error?.code || null;
  err.retryable = missing ? false : isRetryable(status);
  return err;
}

export function isRetryableError(err) {
  return typeof err?.retryable === 'boolean' ? err.retryable : isRetryable(err?.status);
}

/** A short message for people. Messages raised by our own SQL functions are already written for people. */
export function friendlyMessage(err) {
  if (!err) return 'Something went wrong.';
  if (!err.status && err.retryable !== false) return NETWORK_MESSAGE;
  if (err.status === 401) return 'Your sign-in has expired. Sign in again.';
  if (err.status === 403 || err.code === '42501') return 'You do not have permission to change this.';
  return err.message || String(err);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
