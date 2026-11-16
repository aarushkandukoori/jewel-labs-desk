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

// The fictional house the SAMPLE papers are made out to (samples/lib/facts.js HOUSE; test/unit/samples.test.js checks
// the two agree). Without it the agents could not tell that these are the house's exports, and every sample
// shipment would ask "export or import?". The one copy: the app and scripts/eval.js use it too.
export const SAMPLE_HOUSE = {
  name: 'Kavya Gems LLP (SAMPLE)',
  legalEntity: 'Kavya Gems LLP (SAMPLE)',
  address: 'Plot 12, Sample Diamond Park, Katargam, Surat 395004, Gujarat, India',
  taxId: 'SAMPLE00012',
  city: 'Surat',
  country: 'India',
  role: 'exporter',
  environment: 'sandbox',
  letterhead: {
    companyName: 'Kavya Gems LLP (SAMPLE)', address: 'Plot 12, Sample Diamond Park, Katargam, Surat 395004, Gujarat, India',
    cityCountry: 'Surat, India', iec: 'SAMPLE00012', email: 'ops@kavya-gems.example.com', phone: '+91 555 010 0012',
  },
};
// The name the app gives the sandbox workspace (src/main/state.js); a name the person chose instead is kept.
export const SAMPLE_WORKSPACE_NAME = 'Sample workspace';

// The order a house usually sends them: the WhatsApp export, the buyer's email, then the dropped files.
// Papers under later/ (the late packing list) come only when asked for: loadSample({ later: true }).
const CHANNEL_ORDER = ['whatsapp', 'email', 'drop'];
const LATER = 'later';

/**
 * Reads the files under the samples folder and adds them as source kind 'sample'. later: true adds only the
 * papers that arrive late (later/), so the house first sees what is missing, then sees it arrive.
 */
export async function loadSample(ctx, { addFiles, samplesDir, later = false }) {
  await sandboxCheck(ctx);
  await giveSampleIdentity(ctx);
  const all = await listFiles(samplesDir).catch(() => []);
  if (!all.length) throw new Error('The sample shipment is missing from this copy of the app.');
  const top = (file) => file.rel.split('/')[0];
  const files = all.filter((file) => (top(file) === LATER) === later);
  if (!files.length) throw new Error(later ? 'The sample shipment has no late papers.' : 'The sample shipment is missing from this copy of the app.');
  const rank = (file) => {
    const at = CHANNEL_ORDER.indexOf(top(file));
    return at === -1 ? CHANNEL_ORDER.length : at;
  };
  files.sort((a, b) => rank(a) - rank(b) || a.rel.localeCompare(b.rel));
  const batch = await sampleBatch(samplesDir, files);
  const result = await addFiles(batch);
  const what = later ? `Delivered the late SAMPLE papers: ${plural(batch.length, 'file')}` : `Loaded the SAMPLE shipment: ${plural(batch.length, 'file')}`;
  await ctx.log(ctx.systemActor(), 'sample', what);
  return { ...result, files: batch.length, later };
}

/**
 * A sample workspace that has no house of its own yet becomes the SAMPLE house. Details already there (from an
 * earlier load, or typed in) are kept, and so is a name the person chose.
 */
async function giveSampleIdentity(ctx) {
  const workspace = await ctx.store.workspace();
  if (workspace.sample !== true || workspace.legalEntity) return;
  const patch = { ...SAMPLE_HOUSE, letterhead: { ...(workspace.letterhead || {}), ...SAMPLE_HOUSE.letterhead } };
  if (workspace.name && workspace.name !== SAMPLE_WORKSPACE_NAME) delete patch.name;
  await ctx.store.updateWorkspace(patch);
}

/**
 * Files go in as they are. A folder holding a WhatsApp export (_chat.txt plus its photos) is zipped first,
 * the same way the phone exports it, so its attachments stay linked to the chat.
 */
async function sampleBatch(samplesDir, files) {
  const chatFolders = [...new Set(files.filter((f) => path.basename(f.rel) === '_chat.txt').map((f) => path.dirname(f.rel)))]
    .filter((dir) => dir !== '.');
  const batch = [];
  // An unzipped chat folder goes in first, zipped as one export; then the other files in the order given.
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
