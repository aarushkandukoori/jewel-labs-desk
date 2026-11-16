#!/usr/bin/env node
// Writes the SAMPLE shipment used by the demo, the tests and the reading-accuracy harness:
//
//   samples/sample-shipment/   the files, delivered the way real papers reach an export desk
//     whatsapp/   WhatsApp Chat - Kavya Gems Export Desk.zip  (iPhone export: _chat.txt + attachments)
//     email/      PO LDB-7781 from Lumen Diamant.eml          (buyer's purchase order, PDF attached)
//     drop/       shipping bill, air waybill, scanned insurance certificate, factory record (xlsx)
//     drop/shipment-b/, drop/shipment-c/   the two simpler shipments
//     later/      Packing list KG-26-27-041.xlsx              (arrives last in the demo)
//   samples/answers.json       the answer key for every file
//
// Everything is fictional and labelled SAMPLE. The output is the same on every run.
//
// Usage: node samples/generate.js             (writes into samples/)
//        node samples/generate.js --out DIR   (writes DIR/sample-shipment and DIR/answers.json)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSampleSet } from './lib/build.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function outputFolder(args) {
  const at = args.indexOf('--out');
  if (at === -1) return HERE;
  if (!args[at + 1]) throw new Error('--out needs a folder');
  return path.resolve(args[at + 1]);
}

async function main() {
  const root = outputFolder(process.argv.slice(2));
  const shipmentDir = path.join(root, 'sample-shipment');
  const { files, answers } = await buildSampleSet();

  // Start from an empty sample-shipment folder so renamed files do not linger.
  await fs.rm(shipmentDir, { recursive: true, force: true });
  for (const file of files) {
    const target = path.join(shipmentDir, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.bytes);
  }
  await fs.writeFile(path.join(root, 'answers.json'), `${JSON.stringify(answers, null, 2)}\n`);

  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  console.log(`Wrote ${files.length} files (${Math.round(total / 1024)} KB) to ${shipmentDir}`);
  console.log(`Wrote the answer key for ${answers.files.length} documents to ${path.join(root, 'answers.json')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
