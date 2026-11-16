// The SAMPLE shipment for the sandbox: fictional papers the agents can work on without touching real records.
import path from 'node:path';
import JSZip from 'jszip';
import { COLLECTIONS } from '../types.js';
import { listFiles, readBytes } from './files.js';
import { plural } from './context.js';

/** Sample papers only go in a sandbox: one marked so, or (when unmarked) one holding no real papers. */
async function sandboxCheck(ctx) {
  const workspace = await ctx.store.workspace();
  if (workspace.environment === 'live') throw new Error('This is the live workspace. Switch to the sandbox to use the sample shipment.');
  if (workspace.environment === 'sandbox' || workspace.sandbox === true) return;
  const real = await ctx.store.list('documents', (d) => d.source?.kind !== 'sample' && !d.source?.sample);
  if (real.length) throw new Error('This workspace has real papers. Switch to the sandbox to use the sample shipment.');
}

/** Reads every file under the samples folder and adds it as source kind 'sample'. */
export async function loadSample(ctx, { addFiles, samplesDir }) {
  await sandboxCheck(ctx);
  const files = await listFiles(samplesDir).catch(() => []);
  if (!files.length) throw new Error('The sample shipment is missing from this copy of the app.');
  const batch = await sampleBatch(samplesDir, files);
  const result = await addFiles(batch);
  await ctx.log(ctx.systemActor(), 'sample', `Loaded the SAMPLE shipment: ${plural(batch.length, 'file')}`);
  return { ...result, files: batch.length };
}

/**
 * Files go in as they are. A folder holding a WhatsApp export (_chat.txt plus its photos) is zipped first,
 * the same way the phone exports it, so its attachments stay linked to the chat.
 */
async function sampleBatch(samplesDir, files) {
  const chatFolders = [...new Set(files.filter((f) => path.basename(f.rel) === '_chat.txt').map((f) => path.dirname(f.rel)))]
    .filter((dir) => dir !== '.');
  const batch = [];
  for (const dir of chatFolders) {
    const zip = new JSZip();
    for (const file of files.filter((f) => path.dirname(f.rel) === dir)) zip.file(path.basename(file.rel), await readBytes(file.full));
    batch.push({ name: `${path.basename(dir)}.zip`, bytes: await zip.generateAsync({ type: 'uint8array' }), source: { kind: 'sample', ref: dir } });
  }
  for (const file of files) {
    if (chatFolders.includes(path.dirname(file.rel))) continue;
    batch.push({ name: path.basename(file.rel), bytes: await readBytes(file.full), source: { kind: 'sample', ref: file.rel } });
  }
  return batch;
}

/** Empties every collection of the sandbox and removes its stored files. Settings are kept. */
export async function resetSample(ctx) {
  await sandboxCheck(ctx);
  const { store } = ctx;
  let removed = 0;
  for (const collection of COLLECTIONS) {
    for (const item of await store.list(collection)) {
      await removeFilesOf(store, item);
      await store.remove(collection, item.id);
      removed += 1;
    }
  }
  await ctx.log(ctx.systemActor(), 'reset', 'Cleared the sandbox');
  return { removed };
}

async function removeFilesOf(store, item) {
  if (typeof store.removeFile !== 'function') return; // the store keeps the files; nothing points at them any more
  const keys = [item.fileKey, item.unsignedFileKey, ...(item.versions || []).map((v) => v.fileKey)].filter(Boolean);
  for (const key of new Set(keys)) await store.removeFile(key).catch(() => {});
}
