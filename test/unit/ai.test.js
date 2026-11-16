// Tests for the AI layer. No network: every OpenAI call goes to a fake fetch.
// All sample papers below are fictional and labelled SAMPLE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createAI } from '../../src/core/ai/index.js';
import { OPENAI_URL, createClient } from '../../src/core/ai/client.js';
import { normalizeField, normalizeLine } from '../../src/core/ai/normalize.js';
import { checkReportNumber, natureFromText } from '../../src/core/rules/formats.js';
import { SCHEMAS, EXTRACTION_SCHEMA, strictProblems, validate } from '../../src/core/ai/schemas.js';
import { readDocument, linesFromSheet, parseStoneLine, cleanValue, growthFrom } from '../../src/core/ai/heuristics.js';
import { READER_SYSTEM, extractPrompt } from '../../src/core/ai/prompts.js';
import { classifyByRules } from '../../src/core/ai/classify.js';
import { readChatOffline, routeOffline, findRefs, isFluff, draftPackingListOffline } from '../../src/core/ai/conversation.js';
import { parseDate, parseNumber, plainCopy } from '../../src/core/ai/text.js';
import { parseDate as rulesParseDate, parseNumber as rulesParseNumber } from '../../src/core/rules/fields.js';
import { AI_MODELS, AI_REASONING, AI_PROXY_MAX_BODY_BYTES } from '../../src/core/config.js';
import { FIELD_KEYS } from '../../src/core/types.js';

// A fake key, built at run time so no key-shaped text sits in the repo.
const KEY = ['sk', 'test', 'abc123'].join('-');

// ---------------------------------------------------------------- fake OpenAI

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body, signal: init.signal });
    const out = await handler(body, calls.length, init);
    const headers = out.headers || {};
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      json: async () => out.json,
    };
  };
  fn.calls = calls;
  return fn;
}

const ok = (content, { usage = { prompt_tokens: 100, completion_tokens: 20 }, finish = 'stop' } = {}) => ({
  status: 200,
  json: {
    choices: [{ index: 0, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finish }],
    usage,
  },
});
const fail = (status, message, code = null, param = null) => ({ status, json: { error: { message, type: 'invalid_request_error', code, param } } });
const schemaName = (body) => body.response_format?.json_schema?.name;
const lastUserText = (body) => {
  const content = body.messages[body.messages.length - 1].content;
  return typeof content === 'string' ? content : content.map((p) => p.text || '').join('\n');
};
const partsOf = (body) => body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));

function line(values = {}) {
  return {
    lineNo: null, description: null, reportNumber: null, lab: null, shape: null, carat: null, color: null,
    clarity: null, pieces: null, rate: null, amount: null, growth: null, quote: null, ...values,
  };
}
const field = (key, value, quote = value, confidence = 0.95, page = 1) => ({ key, value, quote, page, confidence });
const directAI = (fetch, extra = {}) => createAI({ mode: 'direct', apiKey: KEY, fetch, retryBaseMs: 0, ...extra });

// ---------------------------------------------------------------- sample papers (fictional)

const INVOICE = `SAMPLE
COMMERCIAL INVOICE
Exporter:
Lumen Gems LLP
Plot 14, Sample Diamond Park
Surat 395006, India
Consignee:
Northstar Diamonds BV
Hoveniersstraat 99, 2018 Antwerp, Belgium
Invoice No.: EXP/26-27/031
Invoice Date: 05/11/2026
Terms of Payment: 90 days DA
Terms of Delivery: CIF Antwerp
Country of Origin of Goods: India
Country of Final Destination: Belgium
Description of Goods: Cut & Polished Natural Diamonds
HS Code: 7102.39
Sr Lab Report No Shape Carat Color Clarity Rate (US$/ct) Amount (US$)
1 GIA 2141438167 RD 1.02 G VS1 8,500.00 8,670.00
2 GIA 2141438168 OV 0.71 E SI1 4,000.00 2,840.00
3 IGI 612345678 PR 0.52 F VVS2 3,000.00 1,560.00
TOTAL 3 2.250 13,070.00
The diamonds herein invoiced have been purchased from legitimate sources not involved in funding conflict and in
compliance with United Nations resolutions. The seller hereby guarantees that these diamonds are conflict free, based on
personal knowledge and/or written guarantees provided by the supplier of these diamonds.`;

const PACKING_LIST = `SAMPLE
PACKING LIST
Invoice No: EXP/26-27/031   Date: 05/11/2026
Exporter: Lumen Gems LLP
Buyer: Northstar Diamonds BV
| Sr | Report No | Lab | Shape | Carat | Colour | Clarity |
| 1 | 2141438167 | GIA | ROUND | 1.02 | G | VS1 |
| 2 | 2141438168 | GIA | OVAL | 0.71 | E | SI1 |
| 3 | LG612345678 | IGI | OVAL | 2.01 | F | VVS2 |
TOTAL PCS 3   TOTAL CARATS 3.74
Gross Wt: 2.150 kgs  Net Wt: 0.410 kgs`;

const GIA_REPORT = `SAMPLE
GIA DIAMOND GRADING REPORT
October 22, 2026
GIA Report Number ........ 2141438167
Shape and Cutting Style .. Round Brilliant
Measurements ............. 6.45 - 6.48 x 3.98 mm
Carat Weight ............. 1.02 carat
Color Grade .............. G
Clarity Grade ............ VS1
Cut Grade ................ Excellent
Polish ................... Excellent
Symmetry ................. Very Good
Fluorescence ............. None`;

const IGI_REPORT = `SAMPLE
LABORATORY GROWN DIAMOND REPORT
INTERNATIONAL GEMOLOGICAL INSTITUTE
Report Number: LG612345678
Date: 05 Nov 2026
Shape: OVAL BRILLIANT
Carat Weight: 2.01 Carats
Color Grade: F
Clarity Grade: VVS2
This Laboratory Grown Diamond was created by Chemical Vapor Deposition (CVD) growth process`;

const SHIPPING_BILL = `SAMPLE                                   EXPORTER COPY
                      LEO Date: 03/11/2026      LEO No : 2/4
            Indian Customs EDI System (ICES)
                    Shipping Bill for Export
SB No : 7812345 / 03/11/2026     BRC Realisation Date : 01/05/2027
CHA : ABCDE1234FCH001 SAMPLE CLEARING AGENTS PVT LTD
EXPORTER DETAILS                          CONSIGNEE
ABCDE1234F(   )                           NORTHSTAR DIAMONDS BV
LUMEN GEMS LLP                            HOVENIERSSTRAAT 99
PLOT 14, SAMPLE DIAMOND PARK              ANTWERP 2018
SURAT 395006                              BELGIUM

Port of Loading :SAMPLE DIAMOND BOURSE, K Total Pkgs. : 1
Port of Discharge:Antwerp
Gross Wt(KGS)   :2.150      Net Wt(KGS) :0.410
Country of Dest :BELGIUM No.of Ctrs. : 0
Inv.no.   :EXP/26-27/031   Inv Dt   :05/11/2026
Inv.val :13070.00 USD
ITC(HS) 71023910 CUT AND POLISHED NATURAL DIAMONDS`;

const KP_CERT = `SAMPLE
KIMBERLEY PROCESS CERTIFICATE
Certificate No: BW 0045678
Country of Origin: Botswana, Namibia
Exporting Country: Botswana
Importing Country: India
Exporter: Kalahari Rough Trading (Pty) Ltd, Plot 22, Gaborone, Botswana
Importer: Lumen Gems LLP, Surat, India
HS Code: 7102.10
Carat Weight: 1,245.50
Value (USD): 2,450,000.00
Date of Issue: 12/09/2026
Date of Expiry: 11/11/2026`;

const AIR_WAYBILL = `SAMPLE
HOUSE AIR WAYBILL    NOT NEGOTIABLE
HAWB No: SVX 4471239
MAWB No: 176-1234 5678
Shipper's Name and Address
Lumen Gems LLP
Plot 14, Sample Diamond Park, Surat, India
Consignee's Name and Address
Northstar Diamonds BV
Hoveniersstraat 99, Antwerp, Belgium
Airport of Departure: Mumbai (BOM)
Flight No: EK 501  Date: 06/11/2026
Executed on: 06/11/2026`;

const valueOf = (result, key) => result.fields.find((f) => f.key === key)?.value ?? null;

// ---------------------------------------------------------------- client: headers, models, retries, errors

test('direct mode posts to OpenAI with the key, a strict schema and GPT-5 settings', async () => {
  const fetch = fakeFetch(() => ok({ docType: 'packing_list', confidence: 0.9, reason: 'Title PACKING LIST' }));
  const ai = directAI(fetch);
  const image = { name: 'scan.jpg', kind: 'image', mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) };
  const result = await ai.classify(image, {});
  assert.equal(result.docType, 'packing_list');
  const call = fetch.calls[0];
  assert.equal(call.url, OPENAI_URL);
  assert.equal(call.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(call.body.model, AI_MODELS[0]);
  assert.ok('max_completion_tokens' in call.body);
  assert.ok(!('max_tokens' in call.body) && !('temperature' in call.body));
  assert.equal(call.body.reasoning_effort, AI_REASONING[AI_MODELS[0]] ?? 'minimal');
  assert.equal(call.body.response_format.type, 'json_schema');
  assert.equal(call.body.response_format.json_schema.strict, true);
  assert.ok(partsOf(call.body).some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg;base64,')));
});

test('proxy mode sends the same body to the proxy with the user token', async () => {
  const fetch = fakeFetch(() => ok({ intent: 'status', shipmentRef: null, kinds: [], reply: 'Nothing on file yet.' }));
  const proxyUrl = 'https://example.test/functions/v1/ai';
  const house = '00000000-0000-4000-8000-000000000001';
  const ai = createAI({ mode: 'proxy', proxyUrl, getAccessToken: async () => 'user-session-token', workspaceId: () => house, fetch, retryBaseMs: 0 });
  assert.equal(ai.available, true);
  const answer = await ai.route('Where is my parcel?', { shipments: [] });
  assert.equal(answer.intent, 'status');
  assert.equal(fetch.calls[0].url, proxyUrl);
  assert.equal(fetch.calls[0].headers.Authorization, 'Bearer user-session-token');
  assert.equal(fetch.calls[0].headers['x-jl-workspace'], house); // the proxy counts the call against this house
  assert.equal(fetch.calls[0].body.response_format.json_schema.name, 'route');
  assert.ok(Array.isArray(fetch.calls[0].body.messages));
});

test('proxy mode without a house id says so and reads offline', async () => {
  const fetch = fakeFetch(() => ok({ intent: 'status', shipmentRef: null, kinds: [], reply: 'x' }));
  const ai = createAI({ mode: 'proxy', proxyUrl: 'https://example.test/ai', getAccessToken: async () => 'token', fetch, retryBaseMs: 0 });
  const answer = await ai.route('What is still missing?', { shipments: [] });
  assert.equal(answer.intent, 'whats_missing');
  assert.equal(fetch.calls.length, 0);
  assert.equal(ai.lastError.code, 'no_house');
});

test('direct mode never sends a house header', async () => {
  const fetch = fakeFetch(() => ok({ ok: true }));
  const ai = directAI(fetch, { workspaceId: 'some-house' });
  await ai.check();
  assert.equal(fetch.calls[0].headers['x-jl-workspace'], undefined);
});

test('proxy mode without a token falls back offline and says why', async () => {
  const fetch = fakeFetch(() => ok({}));
  const ai = createAI({ mode: 'proxy', proxyUrl: 'https://example.test/ai', getAccessToken: async () => null, fetch, retryBaseMs: 0 });
  const answer = await ai.route('What is still missing?', { shipments: [] });
  assert.equal(answer.intent, 'whats_missing');
  assert.equal(fetch.calls.length, 0);
  assert.equal(ai.lastError.code, 'signed_out');
});

test('older models get temperature 0 and max_tokens, no reasoning setting', async () => {
  const fetch = fakeFetch(() => ok({ ok: true }));
  const ai = directAI(fetch, { models: ['gpt-4.1-mini'] });
  const status = await ai.check();
  assert.equal(status.ok, true);
  const body = fetch.calls[0].body;
  assert.equal(body.model, 'gpt-4.1-mini');
  assert.equal(body.temperature, 0);
  assert.ok('max_tokens' in body && !('max_completion_tokens' in body) && !('reasoning_effort' in body));
});

test('a model that is not available falls back to the next one and is remembered', async () => {
  const fetch = fakeFetch((body) => (body.model === AI_MODELS[0]
    ? fail(404, `The model ${body.model} does not exist or you do not have access to it.`, 'model_not_found')
    : ok({ ok: true })));
  const ai = directAI(fetch);
  assert.equal((await ai.check()).ok, true);
  assert.deepEqual(fetch.calls.map((c) => c.body.model), [AI_MODELS[0], AI_MODELS[1]]);
  assert.equal(ai.model, AI_MODELS[1]);
  await ai.check();
  assert.equal(fetch.calls.length, 3);
  assert.equal(fetch.calls[2].body.model, AI_MODELS[1]);
});

test('busy (429) and server errors are retried, up to 3 tries', async () => {
  let fetch = fakeFetch((body, n) => (n < 3 ? fail(429, 'Rate limit reached for requests', 'rate_limit_exceeded') : ok({ ok: true })));
  assert.equal((await directAI(fetch).check()).ok, true);
  assert.equal(fetch.calls.length, 3);

  fetch = fakeFetch((body, n) => (n === 1 ? fail(503, 'Service unavailable') : ok({ ok: true })));
  assert.equal((await directAI(fetch).check()).ok, true);
  assert.equal(fetch.calls.length, 2);

  fetch = fakeFetch(() => fail(500, 'The server had an error'));
  const ai = directAI(fetch);
  const status = await ai.check();
  assert.equal(status.ok, false);
  assert.equal(status.code, 'server');
  assert.equal(fetch.calls.length, 3);
});

test('network errors are retried and then reported plainly', async () => {
  let n = 0;
  const fetch = async () => {
    n += 1;
    throw new TypeError('fetch failed');
  };
  const ai = directAI(fetch);
  const status = await ai.check();
  assert.equal(status.code, 'network');
  assert.match(status.message, /Could not reach OpenAI/);
  assert.equal(n, 3);
});

test('a call that hangs is stopped by the timeout', async () => {
  const fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const ai = directAI(fetch, { timeoutMs: 20, tries: 2 });
  const status = await ai.check();
  assert.equal(status.code, 'timeout');
  assert.match(status.message, /too long/);
});

test('clear messages for a missing key, a wrong key and an empty account', async () => {
  const noKey = createAI({ mode: 'direct' });
  assert.equal(noKey.available, false);
  assert.equal((await noKey.check()).code, 'no_key');
  assert.match(noKey.lastError.message, /No OpenAI key/);

  let fetch = fakeFetch(() => fail(401, 'Incorrect API key provided', 'invalid_api_key'));
  let status = await directAI(fetch).check();
  assert.equal(status.code, 'invalid_key');
  assert.match(status.message, /not accepted/);
  assert.equal(fetch.calls.length, 1, 'a wrong key is not retried');

  fetch = fakeFetch(() => fail(429, 'You exceeded your current quota, please check your plan and billing details.', 'insufficient_quota'));
  status = await directAI(fetch).check();
  assert.equal(status.code, 'quota');
  assert.match(status.message, /out of credit/);
  assert.equal(fetch.calls.length, 1, 'an empty account is not retried');
});

test('a rejected reasoning setting falls back to low, and is remembered', async () => {
  const fetch = fakeFetch((body) => (body.reasoning_effort === 'minimal'
    ? fail(400, "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model.", 'unsupported_value', 'reasoning_effort')
    : ok({ ok: true })));
  const ai = directAI(fetch, { models: ['gpt-5-mini'] });
  assert.equal((await ai.check()).ok, true);
  assert.deepEqual(fetch.calls.map((c) => c.body.reasoning_effort), ['minimal', 'low']);
  await ai.check();
  assert.equal(fetch.calls[2].body.reasoning_effort, 'low');
});

test('an answer that is not valid JSON is asked again once, with a repair note', async () => {
  const fetch = fakeFetch((body, n) => (n === 1 ? ok('Sure! Here it is: {oops') : ok({ ok: true })));
  const ai = directAI(fetch);
  assert.equal((await ai.check()).ok, true);
  assert.equal(fetch.calls.length, 2);
  assert.match(lastUserText(fetch.calls[1].body), /did not match the JSON schema/);

  const always = fakeFetch(() => ok({ wrong: 'shape' }));
  const status = await directAI(always).check();
  assert.equal(status.code, 'bad_json');
  assert.equal(always.calls.length, 2);
});

test('usage counts calls and tokens from the responses', async () => {
  const fetch = fakeFetch(() => ok({ ok: true }, { usage: { prompt_tokens: 1200, completion_tokens: 30 } }));
  const ai = directAI(fetch);
  await ai.check();
  await ai.check();
  assert.deepEqual(ai.usage(), { calls: 2, inputTokens: 2400, outputTokens: 60 });
});

// ---------------------------------------------------------------- schemas

test('every schema is strict: additionalProperties false and every key required', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    assert.deepEqual(strictProblems(schema), [], `${name} is not strict`);
  }
  const loose = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'object', properties: { c: { type: 'string' } } } }, required: ['a'] };
  assert.ok(strictProblems(loose).length >= 3);
  assert.deepEqual(EXTRACTION_SCHEMA.properties.fields.items.properties.key.enum, FIELD_KEYS);
});

test('the validator catches wrong types, unknown keys and missing keys', () => {
  const schema = SCHEMAS.classification;
  assert.deepEqual(validate(schema, { docType: 'packing_list', confidence: 0.9, reason: 'x' }), []);
  assert.ok(validate(schema, { docType: 'nope', confidence: 0.9, reason: 'x' }).length);
  assert.ok(validate(schema, { docType: 'packing_list', confidence: '0.9', reason: 'x' }).length);
  assert.ok(validate(schema, { docType: 'packing_list', confidence: 0.9 }).length);
  assert.ok(validate(schema, { docType: 'packing_list', confidence: 0.9, reason: 'x', extra: 1 }).length);
});

// ---------------------------------------------------------------- reading papers with the AI

test('PDFs go as a file part; if the API refuses file parts, the text layer and page images are used', async () => {
  const answer = {
    docType: 'commercial_invoice',
    summary: 'Commercial invoice EXP/26-27/031 — Lumen Gems LLP to Northstar Diamonds BV.',
    fields: [field('invoice.number', 'EXP/26-27/031'), field('invoice.date', '05/11/2026')],
    lines: [line({ lineNo: 1, reportNumber: '2141438167', lab: 'GIA', shape: 'RD', carat: 1.02, color: 'G', clarity: 'VS1', rate: 8500, amount: 8670 })],
    declarations: [],
  };
  const fetch = fakeFetch((body) => (partsOf(body).some((p) => p.type === 'file')
    ? fail(400, "Invalid value: 'file'. Supported values are: 'text' and 'image_url'.", 'invalid_value', 'messages[1].content[1].type')
    : ok(answer)));
  const ai = directAI(fetch);
  const pdf = { name: 'Invoice Copy.pdf', kind: 'pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4 SAMPLE') };
  const options = { textHint: INVOICE, pageImages: ['data:image/png;base64,AAAA'], textSource: 'layer' };
  const result = await ai.extract(pdf, 'commercial_invoice', options);

  assert.equal(fetch.calls.length, 2);
  const first = partsOf(fetch.calls[0].body).find((p) => p.type === 'file');
  assert.match(first.file.file_data, /^data:application\/pdf;base64,/);
  assert.equal(first.file.filename, 'Invoice Copy.pdf');
  const second = partsOf(fetch.calls[1].body);
  assert.ok(second.some((p) => p.type === 'image_url' && p.image_url.detail === 'high'));
  assert.ok(!second.some((p) => p.type === 'file'));
  assert.match(lastUserText(fetch.calls[1].body), /EXP\/26-27\/031/, 'the text layer goes in the prompt');

  assert.ok(result.readBy.startsWith('ai:'));
  assert.equal(valueOf(result, 'invoice.date'), '2026-11-05', 'dates are made ISO');
  assert.ok(!result.summary.includes('—'), 'no em dashes in copy');
  // Rows the AI missed are added from the text layer, with a warning.
  assert.equal(result.lines.length, 3);
  assert.ok(result.warnings.some((w) => /not read by the AI/.test(w)));

  await ai.extract(pdf, 'commercial_invoice', options);
  assert.equal(fetch.calls.length, 3, 'once refused, PDFs go straight as images');
  assert.ok(!partsOf(fetch.calls[2].body).some((p) => p.type === 'file'));
});

test('extraction keeps only known keys and real values, and doubts quotes that are not on the page', async () => {
  const answer = {
    docType: 'shipping_bill',
    summary: 'Shipping bill 7812345.',
    fields: [
      field('shippingBill.number', '7812345'),
      field('shippingBill.date', '03/11/2026'),
      field('leo.date', '2026-11-03', '03/11/2026'),
      field('consignee.name', 'NORTHSTAR DIAMONDS BV'),
      field('goods.nature', 'Natural', 'NATURAL DIAMONDS'),
      field('goods.hsCode', '7102.39.10', '71023910'),
      field('exporter.name', 'GHOST TRADING LLC'),
      field('awb.hawb', null, null),
    ],
    lines: [],
    declarations: [],
  };
  const fetch = fakeFetch(() => ok(answer));
  const ai = directAI(fetch);
  const result = await ai.extract({ name: 'LEO1.pdf', kind: 'text' }, 'shipping_bill', { textHint: SHIPPING_BILL });
  assert.ok(result.readBy.startsWith('ai:'));
  const keys = result.fields.map((f) => f.key);
  assert.ok(!keys.includes('awb.hawb'), 'null values are dropped');
  assert.equal(valueOf(result, 'shippingBill.date'), '2026-11-03');
  assert.equal(valueOf(result, 'goods.nature'), 'natural');
  assert.equal(valueOf(result, 'goods.hsCode'), '71023910');
  const ghost = result.fields.find((f) => f.key === 'exporter.name');
  assert.ok(ghost.confidence <= 0.6, 'a quote that is not in the text layer gets a lower confidence');
  assert.ok(result.warnings.some((w) => w.includes('GHOST TRADING LLC')));
  const invoice = result.fields.find((f) => f.key === 'invoice.number');
  assert.equal(invoice.value, 'EXP/26-27/031', 'a number the AI left out comes from the offline reader');
  assert.ok(invoice.confidence <= 0.45);

  // A scan comes with page images and OCR text: OCR mistakes must not lower the AI's confidence.
  const scan = await ai.extract({ name: 'scan.pdf', kind: 'pdf', bytes: new Uint8Array(0) }, 'shipping_bill', {
    textHint: SHIPPING_BILL, pageImages: ['data:image/png;base64,AAAA'],
  });
  assert.equal(scan.fields.find((f) => f.key === 'exporter.name').confidence, 0.95);
});

test('when the AI fails, extraction falls back to the offline reader with a warning', async () => {
  const fetch = fakeFetch(() => fail(401, 'Incorrect API key provided', 'invalid_api_key'));
  const ai = directAI(fetch);
  const result = await ai.extract({ name: 'pl.txt', kind: 'text' }, 'packing_list', { textHint: PACKING_LIST });
  assert.equal(result.readBy, 'offline');
  assert.equal(result.lines.length, 3);
  assert.match(result.warnings[0], /Read offline: The OpenAI key was not accepted/);
  assert.equal(ai.lastError.code, 'invalid_key');
});

test('classify uses keywords first and only asks the model when unsure', async () => {
  const fetch = fakeFetch(() => ok({ docType: 'insurance_certificate', confidence: 0.88, reason: 'Evidence of insurance' }));
  const ai = directAI(fetch);
  const sure = await ai.classify({ name: 'PACKING LIST-05.11.2026.xlsx', kind: 'sheet' }, { textHint: PACKING_LIST });
  assert.equal(sure.docType, 'packing_list');
  assert.ok(sure.confidence >= 0.85);
  assert.equal(fetch.calls.length, 0);

  assert.deepEqual(await ai.classify({ name: 'chat.zip', kind: 'chat' }), { docType: 'whatsapp_chat', confidence: 1, reason: 'WhatsApp chat export' });
  assert.equal((await ai.classify({ name: 'mail.eml', kind: 'email' })).docType, 'email');
  assert.equal(fetch.calls.length, 0);

  const unsure = await ai.classify({ name: 'scan 0042.pdf', kind: 'text' }, { textHint: 'Ref 12 dated 01/11/2026 some unclear text' });
  assert.equal(unsure.docType, 'insurance_certificate');
  assert.equal(fetch.calls.length, 1);
  assert.equal(schemaName(fetch.calls[0].body), 'classification');
});

test('keyword classifier recognises the usual papers', () => {
  const cases = [
    ['Invoice Copy.pdf', INVOICE, 'commercial_invoice'],
    ['packing list.pdf', PACKING_LIST, 'packing_list'],
    ['2141438167.pdf', GIA_REPORT, 'lab_report'],
    ['LG612345678.pdf', IGI_REPORT, 'lab_report'],
    ['LEO1.pdf', SHIPPING_BILL, 'shipping_bill'],
    ['kp.pdf', KP_CERT, 'kp_certificate'],
    ['awb.pdf', AIR_WAYBILL, 'air_waybill'],
  ];
  for (const [name, text, type] of cases) {
    const result = classifyByRules({ name, text });
    assert.equal(result.docType, type, name);
    assert.ok(result.confidence >= 0.85, `${name} confidence ${result.confidence}`);
  }
  assert.ok(classifyByRules({ name: 'IMG_2231.jpg', text: '' }).confidence < 0.85);
});

// ---------------------------------------------------------------- offline reader

test('offline reader: commercial invoice', () => {
  const r = readDocument({ text: INVOICE, docType: 'commercial_invoice' });
  assert.equal(valueOf(r, 'invoice.number'), 'EXP/26-27/031');
  assert.equal(valueOf(r, 'invoice.date'), '2026-11-05');
  assert.equal(valueOf(r, 'exporter.name'), 'Lumen Gems LLP');
  assert.equal(valueOf(r, 'exporter.country'), 'India');
  assert.equal(valueOf(r, 'consignee.name'), 'Northstar Diamonds BV');
  assert.equal(valueOf(r, 'consignee.country'), 'Belgium');
  assert.equal(valueOf(r, 'goods.hsCode'), '710239');
  assert.equal(valueOf(r, 'goods.nature'), 'natural');
  assert.equal(valueOf(r, 'goods.form'), 'polished');
  assert.equal(valueOf(r, 'goods.incoterm'), 'CIF');
  assert.equal(valueOf(r, 'goods.totalValue'), '13070');
  assert.equal(valueOf(r, 'goods.totalCarats'), '2.25');
  assert.equal(valueOf(r, 'goods.currency'), 'USD');
  assert.equal(r.lines.length, 3);
  assert.deepEqual(
    { ...r.lines[0], quote: undefined },
    { lineNo: 1, description: null, reportNumber: '2141438167', lab: 'GIA', shape: 'RD', carat: 1.02, color: 'G',
      clarity: 'VS1', pieces: null, rate: 8500, amount: 8670, growth: null, quote: undefined },
  );
  assert.equal(r.declarations.length, 2);
  assert.match(r.declarations[0], /^The diamonds herein invoiced/);
  for (const f of r.fields) assert.ok(f.confidence <= 0.6, `${f.key} confidence`);
});

test('offline reader: packing list table and a spreadsheet', () => {
  const r = readDocument({ text: PACKING_LIST, docType: 'packing_list' });
  assert.equal(r.lines.length, 3);
  assert.equal(r.lines[2].reportNumber, 'LG612345678');
  assert.equal(r.lines[2].growth, 'lab-grown');
  assert.equal(r.lines[2].lab, 'IGI');
  assert.equal(valueOf(r, 'goods.totalPieces'), '3');
  assert.equal(valueOf(r, 'goods.totalCarats'), '3.74');
  assert.equal(valueOf(r, 'goods.grossWeight'), '2.15 kg');
  assert.equal(valueOf(r, 'goods.totalValue'), null, 'carats are not mistaken for money');
  assert.equal(valueOf(r, 'buyer.name'), 'Northstar Diamonds BV');
  assert.equal(valueOf(r, 'buyer.address'), null, 'table rows are not an address');

  const sheet = { sheets: [{ name: 'PL', rows: [
    ['SAMPLE PACKING LIST'],
    ['Sr No', 'Certificate No', 'Shape', 'Weight (cts)', 'Color', 'Clarity', 'Rate', 'Amount'],
    [1, '2141438167', 'RD', 1.02, 'G', 'VS 1', 8500, 8670],
    [2, 'LG 612345678', 'OV', 2.01, 'F', 'VVS2', 1200, 2412],
    ['TOTAL', '', '', 3.03, '', '', '', 11082],
  ] }] };
  const lines = linesFromSheet(sheet);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].clarity, 'VS1');
  assert.equal(lines[1].reportNumber, 'LG612345678');
  assert.equal(lines[1].growth, 'lab-grown');
  assert.equal(lines[1].amount, 2412);
});

test('offline reader: tab-separated text layer with parties side by side', () => {
  const text = [
    'SAMPLE',
    'COMMERCIAL INVOICE',
    'Exporter\tInvoice No. & Date',
    'Lumen Gems LLP\tEXP/26-27/044 dt. 09/11/2026',
    "Plot 14, Sample Diamond Park\tExporter's Ref: LG/44",
    'Surat 395006, India',
    '',
    'Consignee\tBuyer (if other than consignee)',
    'Northstar Diamonds BV\tSouthgate Gems Inc',
    'Hoveniersstraat 99, Antwerp, Belgium\t580 Sample Avenue, New York, USA',
    '',
    'Sr\tReport No\tShape\tCarat\tColor\tClarity\tRate\tAmount',
    '1\t2141438167\tRD\t1.02\tG\tVS1\t8,500.00\t8,670.00',
  ].join('\n');
  const r = readDocument({ text, pageTexts: [text, 'SAMPLE page two'], docType: 'commercial_invoice' });
  assert.equal(valueOf(r, 'exporter.name'), 'Lumen Gems LLP');
  assert.equal(valueOf(r, 'exporter.country'), 'India');
  assert.equal(valueOf(r, 'consignee.name'), 'Northstar Diamonds BV');
  assert.equal(valueOf(r, 'buyer.name'), 'Southgate Gems Inc');
  assert.equal(valueOf(r, 'buyer.country'), 'USA');
  assert.equal(valueOf(r, 'invoice.number'), 'EXP/26-27/044');
  assert.equal(r.fields.find((f) => f.key === 'buyer.name').page, 1);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].amount, 8670);

  const sheetText = 'Sheet: Packing\nSAMPLE\nSr No\tCertificate No\tShape\tWeight\tColor\tClarity\n1\t2141438167\tRD\t1.02\tG\tVS1\n2\tLG612345678\tOV\t2.01\tF\tVVS2';
  const sheet = readDocument({ text: sheetText, docType: 'packing_list' });
  assert.deepEqual(sheet.lines.map((l) => [l.lineNo, l.reportNumber, l.carat]), [[1, '2141438167', 1.02], [2, 'LG612345678', 2.01]]);
});

test('offline reader: grading reports (GIA dot leaders, IGI lab-grown)', () => {
  const gia = readDocument({ text: GIA_REPORT, docType: 'lab_report' });
  assert.equal(valueOf(gia, 'lab.name'), 'GIA');
  assert.equal(valueOf(gia, 'lab.reportNumber'), '2141438167');
  assert.equal(valueOf(gia, 'lab.reportDate'), '2026-10-22');
  assert.equal(valueOf(gia, 'lab.shape'), 'Round Brilliant');
  assert.equal(valueOf(gia, 'lab.carat'), '1.02');
  assert.equal(valueOf(gia, 'lab.color'), 'G');
  assert.equal(valueOf(gia, 'lab.clarity'), 'VS1');
  assert.equal(valueOf(gia, 'lab.measurements'), '6.45 - 6.48 x 3.98 mm');
  assert.equal(gia.lines.length, 1);
  assert.equal(gia.lines[0].carat, 1.02);

  const igi = readDocument({ text: IGI_REPORT, docType: 'lab_report' });
  assert.equal(valueOf(igi, 'lab.name'), 'IGI');
  assert.equal(valueOf(igi, 'lab.reportNumber'), 'LG612345678');
  assert.equal(valueOf(igi, 'lab.growthMethod'), 'CVD');
  assert.equal(valueOf(igi, 'goods.nature'), 'lab-grown');
  assert.equal(igi.lines[0].growth, 'lab-grown');
});

test('offline reader: Indian shipping bill with two columns', () => {
  const r = readDocument({ text: SHIPPING_BILL, docType: 'shipping_bill' });
  assert.equal(valueOf(r, 'shippingBill.number'), '7812345');
  assert.equal(valueOf(r, 'shippingBill.date'), '2026-11-03');
  assert.equal(valueOf(r, 'leo.date'), '2026-11-03');
  assert.equal(valueOf(r, 'leo.number'), '2/4');
  assert.equal(valueOf(r, 'doc.number'), '7812345');
  assert.equal(valueOf(r, 'exporter.name'), 'LUMEN GEMS LLP');
  assert.equal(valueOf(r, 'consignee.name'), 'NORTHSTAR DIAMONDS BV');
  assert.equal(valueOf(r, 'consignee.country'), 'BELGIUM');
  assert.equal(valueOf(r, 'broker.name'), 'SAMPLE CLEARING AGENTS PVT LTD');
  assert.equal(valueOf(r, 'goods.destinationCountry'), 'BELGIUM');
  assert.equal(valueOf(r, 'goods.portOfLoading'), 'SAMPLE DIAMOND BOURSE, K');
  assert.equal(valueOf(r, 'invoice.number'), 'EXP/26-27/031');
  assert.equal(valueOf(r, 'goods.hsCode'), '71023910');
  assert.equal(valueOf(r, 'goods.netWeight'), '0.41 kg');
});

test('offline reader: KP certificate and air waybill', () => {
  const kp = readDocument({ text: KP_CERT, docType: 'kp_certificate' });
  assert.equal(valueOf(kp, 'kp.certificateNumber'), 'BW 0045678');
  assert.equal(valueOf(kp, 'kp.countriesOfMining'), 'Botswana, Namibia');
  assert.equal(valueOf(kp, 'kp.exportingCountry'), 'Botswana');
  assert.equal(valueOf(kp, 'kp.importingCountry'), 'India');
  assert.equal(valueOf(kp, 'kp.carats'), '1245.5');
  assert.equal(valueOf(kp, 'kp.value'), '2450000');
  assert.equal(valueOf(kp, 'kp.issueDate'), '2026-09-12');
  assert.equal(valueOf(kp, 'kp.expiryDate'), '2026-11-11');
  assert.equal(valueOf(kp, 'goods.form'), 'rough');
  assert.equal(valueOf(kp, 'consignee.name'), 'Lumen Gems LLP');

  const awb = readDocument({ text: AIR_WAYBILL, docType: 'air_waybill' });
  assert.equal(valueOf(awb, 'awb.hawb'), 'SVX 4471239');
  assert.equal(valueOf(awb, 'awb.mawb'), '176-12345678');
  assert.equal(valueOf(awb, 'awb.flight'), 'EK501');
  assert.equal(valueOf(awb, 'awb.date'), '2026-11-06');
  assert.equal(valueOf(awb, 'exporter.name'), 'Lumen Gems LLP');
  assert.equal(valueOf(awb, 'consignee.country'), 'Belgium');
});

test('offline reader pieces: dates, numbers, rows and values', () => {
  assert.equal(parseDate('22/10/2026'), '2026-10-22');
  assert.equal(parseDate('05/11/2026'), '2026-11-05');
  assert.equal(parseDate('10/22/2026'), '2026-10-22');
  assert.equal(parseDate('22-OCT-26'), '2026-10-22');
  assert.equal(parseDate('October 22, 2026'), '2026-10-22');
  assert.equal(parseDate('2026-10-22'), '2026-10-22');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseNumber('2,49,503.13'), 249503.13);
  assert.equal(parseNumber('US$ 1,250.00'), 1250);
  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('1,02'), 1.02);
  assert.equal(parseNumber('0,510 ct'), 0.51, 'a decimal comma after 0, not 510 carats');
  // One reader for dates and numbers in the whole app: the AI layer uses the one the rules use.
  assert.equal(parseDate, rulesParseDate);
  assert.equal(parseNumber, rulesParseNumber);
  assert.equal(cleanValue('UNITED ARAB EMIRATES No.of Ctrs. : 0'), 'UNITED ARAB EMIRATES');
  const typed = parseStoneLine('1.02 g vs1 round GIA 2141438167');
  assert.equal(typed.reportNumber, '2141438167');
  assert.equal(typed.color, 'G');
  assert.equal(typed.clarity, 'VS1');
  const lot = parseStoneLine('1 CUT & POLISHED DIAMONDS 7102.39 125 45.20 1,250.00 56,500.00');
  assert.deepEqual([lot.pieces, lot.carat, lot.rate, lot.amount], [125, 45.2, 1250, 56500]);
  assert.equal(parseStoneLine('1\t2141438167\tGIA\tRD\t1.02\tG\tVS1\t8,670.00').amount, 8670, 'an amount column alone');
  assert.equal(parseStoneLine('Tel: +91 9876543210 Contact AS Shah'), null, 'a phone number is not a stone');
  assert.equal(plainCopy('Ready — filed with the broker'), 'Ready, prepared with the broker');
});

// ---------------------------------------------------------------- chats, emails, routing, packing lists

const CHAT = {
  title: 'WhatsApp Chat with Sample Export Desk',
  messages: [
    { at: '2026-11-05T09:00:00', author: null, text: 'Messages and calls are end-to-end encrypted.' },
    { at: '2026-11-05T09:01:00', author: 'Ravi', text: 'Good morning sir 🙏' },
    { at: '2026-11-05T09:02:00', author: 'Ravi', text: 'Missed voice call' },
    { at: '2026-11-05T09:03:00', author: 'Ravi', text: 'Please prepare export papers for invoice EXP/26-27/031, parcel goes to Antwerp on Friday' },
    { at: '2026-11-05T09:04:00', author: 'Ravi', text: '1.02 G VS1 RD GIA 2141438167\n0.71 E SI1 OV GIA 2141438168' },
    { at: '2026-11-05T09:05:00', author: 'Meera', text: 'ok' },
    { at: '2026-11-05T09:06:00', author: 'Meera', text: '<Media omitted>' },
    { at: '2026-11-05T09:07:00', author: 'Meera', text: 'AWB 176-1234 5678 booked with the courier' },
    { at: '2026-11-05T09:08:00', author: 'Meera', text: 'invoice.pdf (file attached)', attachment: 'invoice.pdf' },
  ],
};

test('chat reading offline: clears the fluff, finds requests, typed stones and refs', () => {
  assert.equal(isFluff(CHAT.messages[1]), true);
  assert.equal(isFluff(CHAT.messages[2]), true);
  assert.equal(isFluff(CHAT.messages[8]), false, 'a message with a file is kept');
  const r = readChatOffline(CHAT);
  assert.ok(!r.relevant.some((m) => /Good morning|Missed voice call|Media omitted/.test(m.text)));
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].ref, 'EXP/26-27/031');
  assert.equal(r.packing.length, 1);
  assert.equal(r.packing[0].ref, 'EXP/26-27/031', 'stones typed after a ref belong to it');
  assert.deepEqual(r.packing[0].lines.map((l) => l.reportNumber), ['2141438167', '2141438168']);
  assert.deepEqual(r.refs, ['EXP/26-27/031', '176-1234 5678']);
  assert.deepEqual(findRefs('Parcel NS/2026/118 and JL-EXP-1115-01, report 2141438167'), ['NS/2026/118', 'JL-EXP-1115-01']);
});

test('chat reading with the AI copies the original messages and drops anything not in the chat', async () => {
  const answer = {
    relevant: [{ index: 3, why: 'Request for papers' }, { index: 4, why: 'Stone list' }, { index: 99, why: 'made up' }],
    requests: [{ index: 3, ref: 'EXP/26-27/031' }],
    packing: [{ index: 4, ref: 'EXP/26-27/031', lines: [
      line({ reportNumber: '2141438167', carat: 1.02, color: 'G', clarity: 'VS1', shape: 'RD', lab: 'GIA', quote: '1.02 G VS1 RD GIA 2141438167' }),
      line({ reportNumber: '2299999999', carat: 3.5, color: 'D', clarity: 'IF', quote: 'invented' }),
    ] }],
    refs: ['EXP/26-27/031', 'INV-9999'],
  };
  const fetch = fakeFetch(() => ok(answer));
  const ai = directAI(fetch);
  const r = await ai.readChat(CHAT);
  const sent = lastUserText(fetch.calls[0].body);
  assert.ok(!/Good morning|Missed voice call|Media omitted/.test(sent), 'fluff never reaches the model');
  assert.equal(r.relevant.length, 2);
  assert.equal(r.relevant[0].author, 'Ravi');
  assert.match(r.requests[0].text, /^Please prepare export papers/);
  assert.equal(r.packing[0].lines.length, 1, 'a stone that is not in the chat is dropped');
  assert.deepEqual(r.refs, ['EXP/26-27/031'], 'a ref that is not in the chat is dropped');
});

test('email reading with the AI keeps only lines really in the email', async () => {
  const email = {
    from: 'buyer@example.test',
    to: 'exports@example.test',
    subject: 'Parcel EXP/26-27/031',
    date: '2026-11-06T10:00:00Z',
    text: 'Dear team,\nPlease send the KP copy and the packing list for EXP/26-27/031 today.\nRegards,\nAnna\n\nOn Mon, 2 Nov 2026 Lumen wrote:\n> old text',
  };
  const fetch = fakeFetch(() => ok({
    relevant: [{ text: 'Please send the KP copy and the packing list for EXP/26-27/031 today.', why: 'Request' }, { text: 'Ship it by air tomorrow', why: 'invented' }],
    requests: [{ text: 'Please send the KP copy and the packing list for EXP/26-27/031 today.', ref: 'EXP/26-27/031' }],
    refs: ['EXP/26-27/031'],
  }));
  const r = await directAI(fetch).readEmail(email);
  assert.equal(r.relevant.length, 1);
  assert.equal(r.relevant[0].author, 'buyer@example.test');
  assert.equal(r.requests[0].ref, 'EXP/26-27/031');
  assert.ok(!lastUserText(fetch.calls[0].body).includes('old text'), 'quoted older mail is not sent');
});

const SHIPMENTS = [
  { id: 's1', ref: 'EXP/26-27/031', invoiceNumber: 'EXP/26-27/031', status: 'questions', updatedAt: '2026-11-05T10:00:00Z' },
  { id: 's2', ref: 'NS/2026/118', status: 'ready_to_sign', updatedAt: '2026-11-04T10:00:00Z' },
];

test('route offline understands the usual requests', () => {
  const ctx = { shipments: SHIPMENTS, openQuestions: [{ shipmentId: 's1', text: 'Which KP?', status: 'open' }] };
  let r = routeOffline('Prepare the papers for my latest shipment', ctx);
  assert.deepEqual([r.intent, r.shipmentRef, r.kinds], ['prepare_papers', 'EXP/26-27/031', []]);
  r = routeOffline('Prepare the export paper and the EU statement', ctx);
  assert.deepEqual(r.kinds, ['export_pack', 'eu_dds']);
  r = routeOffline('What is still missing for NS/2026/118?', ctx);
  assert.deepEqual([r.intent, r.shipmentRef], ['whats_missing', 'NS/2026/118']);
  r = routeOffline('Need to send export papers for EXP/26-27/031 soon', ctx);
  assert.deepEqual([r.intent, r.kinds], ['prepare_papers', ['export_pack']]);
  r = routeOffline('Build the packing list from the chat', ctx);
  assert.equal(r.intent, 'build_packing_list');
  r = routeOffline('status of NS/2026/118', ctx);
  assert.equal(r.intent, 'status');
  assert.match(r.reply, /NS\/2026\/118: Ready to sign/);
  r = routeOffline('Prepare papers for EXP/99-00/001', ctx);
  assert.equal(r.shipmentRef, 'EXP/99-00/001');
  assert.match(r.reply, /No shipment EXP\/99-00\/001 on file yet/);
});

test('route with the AI: refs must be on file or typed, replies are plain', async () => {
  let fetch = fakeFetch(() => ok({ intent: 'prepare_papers', shipmentRef: 'exp/26-27/031', kinds: ['us_cbp_certificate', 'not_a_kind'], reply: 'On it — the CBP paper will be filed today.' }));
  let r = await directAI(fetch).route('Make the US certificate for EXP/26-27/031', { shipments: SHIPMENTS });
  assert.deepEqual([r.intent, r.shipmentRef, r.kinds], ['prepare_papers', 'EXP/26-27/031', ['us_cbp_certificate']]);
  assert.ok(!r.reply.includes('—') && !/\bfiled\b/.test(r.reply));
  const sent = lastUserText(fetch.calls[0].body);
  assert.match(sent, /NS\/2026\/118/, 'the shipment list goes to the model');

  fetch = fakeFetch(() => ok({ intent: 'prepare_papers', shipmentRef: 'INV-404', kinds: [], reply: 'Preparing.' }));
  r = await directAI(fetch).route('Prepare the papers for my latest shipment', { shipments: SHIPMENTS });
  assert.equal(r.shipmentRef, 'EXP/26-27/031', 'a made-up ref is replaced by the latest shipment');
});

test('packing list drafts never invent stones', async () => {
  const chatLines = [{ at: '2026-11-05T09:04:00', author: 'Ravi', text: '1.02 G VS1 RD 2141438167\n0.71 E SI1 2141438168' }];
  const documents = [{ id: 'd9', fileName: '2141438168.pdf', docType: 'lab_report', lines: [line({ lineNo: 1, reportNumber: '2141438168', lab: 'GIA', shape: 'Oval', carat: 0.71, color: 'E', clarity: 'SI1' })] }];

  const offline = draftPackingListOffline({ shipment: SHIPMENTS[0], chatLines, documents });
  assert.equal(offline.lines.length, 2);
  assert.equal(offline.sources.length, 2);
  assert.equal(offline.sources[0].kind, 'chat');
  assert.equal(offline.lines[1].shape, 'Oval', 'missing details come from the grading report');
  assert.match(offline.notes, /Drafted 2 lines/);

  const fetch = fakeFetch(() => ok({
    lines: [
      { source: 'C1', ...line({ reportNumber: '2141438167', carat: 1.02, color: 'G', clarity: 'VS1', shape: 'RD', quote: '1.02 G VS1 RD 2141438167' }) },
      { source: 'C2', ...line({ reportNumber: '2141438168', carat: 0.71, color: 'E', clarity: 'SI1', shape: 'Oval', lab: 'GIA' }) },
      { source: 'C1', ...line({ reportNumber: '2177777777', carat: 2.2 }) },
      { source: 'X5', ...line({ reportNumber: '2141438167', carat: 1.02 }) },
    ],
    notes: 'Two stones from the chat.',
  }));
  const r = await directAI(fetch).draftPackingList({ shipment: SHIPMENTS[0], chatLines, documents });
  assert.deepEqual(r.lines.map((l) => l.reportNumber), ['2141438167', '2141438168']);
  assert.equal(r.sources.length, r.lines.length);
  assert.deepEqual(r.sources.map((s) => s.kind), ['chat', 'chat']);
  assert.equal(r.sources[1].quote, '0.71 E SI1 2141438168');
  assert.match(r.notes, /2 lines were left out/);
  assert.match(lastUserText(fetch.calls[0].body), /\[D1-1\] 2141438168\.pdf/);
});

test('packing list drafts accept packing notes from readChat (lines already read)', async () => {
  const chat = readChatOffline(CHAT);
  const chatLines = chat.packing.map((p) => ({ text: `Packing notes for ${p.ref}`, ref: p.ref, lines: p.lines }));
  const offline = draftPackingListOffline({ chatLines });
  assert.deepEqual(offline.lines.map((l) => l.reportNumber), ['2141438167', '2141438168']);
  assert.equal(offline.sources[0].quote, '1.02 G VS1 RD GIA 2141438167');

  const fetch = fakeFetch(() => ok({ lines: [{ source: 'C2', ...line({ reportNumber: '2141438168', carat: 0.71 }) }], notes: 'One stone.' }));
  const r = await directAI(fetch).draftPackingList({ chatLines });
  const sent = lastUserText(fetch.calls[0].body);
  assert.match(sent, /\[C2\] 0\.71 E SI1 OV GIA 2141438168/);
  assert.ok(!sent.includes('Packing notes for'), 'the label line is not material');
  assert.equal(r.lines[0].reportNumber, '2141438168');
});

test('mode off and mock mode work without any network', async () => {
  const off = createAI({ mode: 'off' });
  assert.equal(off.available, false);
  assert.equal(off.model, 'offline');
  const read = await off.extract({ name: 'kp.pdf', kind: 'pdf', bytes: new Uint8Array(4) }, 'kp_certificate', { textHint: KP_CERT });
  assert.equal(read.readBy, 'offline');
  assert.equal(valueOf(read, 'kp.certificateNumber'), 'BW 0045678');
  assert.equal((await off.classify({ name: 'x.pdf', kind: 'pdf' }, { textHint: KP_CERT })).docType, 'kp_certificate');
  assert.deepEqual(off.usage(), { calls: 0, inputTokens: 0, outputTokens: 0 });

  const seen = [];
  const mock = createAI({
    mode: 'mock',
    mockHandler: (task, args) => {
      seen.push(task);
      if (task === 'extract') {
        const fields = [field('invoice.number', 'M-1'), { key: 'made.up', value: 'x', quote: 'x', page: 1, confidence: 0.9 }];
        return { docType: args.docType, summary: 'Mock', fields, lines: [], declarations: [] };
      }
      return undefined;
    },
  });
  const mocked = await mock.extract({ name: 'a.pdf', kind: 'pdf' }, 'commercial_invoice', {});
  assert.equal(mocked.readBy, 'mock');
  assert.equal(valueOf(mocked, 'invoice.number'), 'M-1');
  assert.ok(!mocked.fields.some((f) => f.key === 'made.up'), 'unknown keys are dropped');
  const routed = await mock.route('What is still missing?', { shipments: SHIPMENTS });
  assert.equal(routed.intent, 'whats_missing');
  assert.deepEqual(seen, ['extract', 'route']);
});

// ---------------------------------------------------------------- when the AI fails or the request is too big

const PROXY_URL = 'https://example.test/functions/v1/ai';
const HOUSE = '00000000-0000-4000-8000-000000000001';
const proxyAI = (fetch, extra = {}) => createAI({
  mode: 'proxy', proxyUrl: PROXY_URL, getAccessToken: async () => 'user-session-token', workspaceId: HOUSE, fetch, retryBaseMs: 0, ...extra,
});

test("the proxy's daily cap is not 'busy': it is not retried and says when the count starts again", async () => {
  const fetch = fakeFetch(() => ({
    status: 429,
    json: { error: { message: 'This house has used its 600 AI calls for today. The count resets at midnight UTC.', type: 'jewel_labs_proxy', code: 'daily_limit' } },
  }));
  const status = await proxyAI(fetch).check();
  assert.equal(status.code, 'quota');
  assert.match(status.message, /used its Jewel Labs AI calls for today.*midnight UTC/);
  assert.doesNotMatch(status.message, /busy|try again/);
  assert.equal(fetch.calls.length, 1);
});

test('a reading that fell back after an AI failure says so, so the paper can be read again later', async () => {
  let down = true;
  const answer = { docType: 'packing_list', summary: 'Packing list.', fields: [field('invoice.number', 'EXP/26-27/031')], lines: [], declarations: [] };
  const fetch = fakeFetch(() => (down ? { status: 503, json: { error: { message: 'Service unavailable' } } } : ok(answer)));
  const ai = directAI(fetch);
  const paper = { name: 'pl.txt', kind: 'text' };

  const offline = await ai.extract(paper, 'packing_list', { textHint: PACKING_LIST });
  assert.deepEqual([offline.readBy, offline.aiError], ['offline', 'server']);
  assert.match(offline.warnings[0], /^Read offline: OpenAI had a server problem\.$/, 'no promise that nobody keeps');
  assert.equal((await ai.classify({ name: 'scan.pdf', kind: 'pdf' }, { textHint: 'SAMPLE' })).aiError, 'server');
  const chat = await ai.readChat(CHAT);
  assert.deepEqual([chat.readBy, chat.aiError], ['offline', 'server']);
  assert.match(chat.warnings[0], /Read offline/);
  assert.equal(chat.requests.length, 1, 'the offline reading is still there');
  const email = await ai.readEmail({ from: 'a@example.test', subject: 'EXP/26-27/031', text: 'Please send the KP copy.' });
  assert.deepEqual([email.readBy, email.aiError], ['offline', 'server']);

  down = false; // the AI is back: the same paper is read by the AI, with no mark
  const again = await ai.extract(paper, 'packing_list', { textHint: PACKING_LIST });
  assert.ok(again.readBy.startsWith('ai:'));
  assert.equal(again.aiError, undefined);

  // A failure the same request cannot get past is not marked either: reading it again would fail again.
  const refusing = fakeFetch(() => ({ status: 200, json: { choices: [{ message: { role: 'assistant', content: null, refusal: 'No.' }, finish_reason: 'stop' }] } }));
  const refused = await directAI(refusing).extract(paper, 'packing_list', { textHint: PACKING_LIST });
  assert.deepEqual([refused.readBy, refused.aiError], ['offline', undefined]);
  assert.match(refused.warnings[0], /A person needs to look at it/);

  // With the AI switched off nothing failed, so nothing is marked for a second reading.
  const off = createAI({ mode: 'off' });
  assert.equal((await off.extract(paper, 'packing_list', { textHint: PACKING_LIST })).aiError, undefined);
  assert.equal((await off.readChat(CHAT)).aiError, undefined);
});

const pdfItem = (name, size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('%PDF-1.7 SAMPLE'));
  return { name, kind: 'pdf', mime: 'application/pdf', bytes };
};
const sentFile = (call) => partsOf(call.body).find((p) => p.type === 'file')?.file.filename || null;
const EXTRACTED = { docType: 'commercial_invoice', summary: 'Invoice.', fields: [], lines: [], declarations: [] };

test('a PDF the API refuses is read again without its file; the next PDFs still go as files', async () => {
  const fetch = fakeFetch((body) => (sentFile({ body }) === 'combined-scan-180-pages.pdf'
    ? fail(400, 'Invalid file: the PDF has more pages than allowed (100).', 'invalid_value', 'messages[1].content[1].file')
    : ok(EXTRACTED)));
  const ai = directAI(fetch);
  const big = await ai.extract(pdfItem('combined-scan-180-pages.pdf'), 'other', { textHint: INVOICE, pageImages: ['data:image/png;base64,AAAA'] });
  assert.ok(big.readBy.startsWith('ai:'), 'read by the AI from its text and page images');
  assert.ok(partsOf(fetch.calls[1].body).some((p) => p.type === 'image_url'));
  await ai.extract(pdfItem('Invoice KG-26-27-041.pdf'), 'commercial_invoice', { textHint: INVOICE });
  await ai.extract(pdfItem('combined-scan-180-pages.pdf'), 'other', { textHint: INVOICE });
  assert.deepEqual(fetch.calls.map(sentFile), ['combined-scan-180-pages.pdf', null, 'Invoice KG-26-27-041.pdf', null]);
});

test('PDFs stop going as files once the API has refused two different ones and taken none', async () => {
  const fetch = fakeFetch((body) => (sentFile({ body }) ? fail(400, 'This proxy does not pass on PDF files.', 'bad_request') : ok(EXTRACTED)));
  const ai = directAI(fetch);
  for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) await ai.extract(pdfItem(name), 'other', { textHint: INVOICE });
  assert.deepEqual(fetch.calls.map(sentFile), ['a.pdf', null, 'b.pdf', null, null]);
});

test('through the proxy every request fits under its body limit', async () => {
  // The proxy refuses bodies over 25 MiB (MAX_BODY_BYTES in its source); the app uses the same number.
  const source = fs.readFileSync(new URL('../../backend/supabase/functions/ai/index.ts', import.meta.url), 'utf8');
  const [, mib] = source.match(/const MAX_BODY_BYTES = (\d+) \* 1024 \* 1024;/);
  assert.equal(AI_PROXY_MAX_BODY_BYTES, Number(mib) * 1024 * 1024);

  const sizes = [];
  const fetch = fakeFetch((body, n, init) => {
    sizes.push(Buffer.byteLength(init.body));
    return ok(EXTRACTED);
  });
  const ai = proxyAI(fetch);
  // 19.5 MiB of PDF is 26 MiB as base64: it goes as text (and page images) instead of as a file.
  await ai.extract(pdfItem('Scan of all papers.pdf', 19.5 * 1024 * 1024), 'other', { textHint: INVOICE });
  assert.equal(sentFile(fetch.calls[0]), null);
  // Page images go while they fit: three of 9 MiB do not.
  const page = `data:image/png;base64,${'A'.repeat(9 * 1024 * 1024)}`;
  const scan = { name: 'scan.pdf', kind: 'pdf', mime: 'application/pdf', bytes: new Uint8Array(0) }; // pages only
  await ai.extract(scan, 'other', { textHint: INVOICE, pageImages: [page, page, page] });
  assert.equal(partsOf(fetch.calls[1].body).filter((p) => p.type === 'image_url').length, 2);
  assert.ok(sizes.every((size) => size < AI_PROXY_MAX_BODY_BYTES), sizes.join(', '));
  // Straight to OpenAI the PDF still goes as a file.
  const direct = fakeFetch(() => ok(EXTRACTED));
  await directAI(direct).extract(pdfItem('Scan of all papers.pdf', 19.5 * 1024 * 1024), 'other', { textHint: INVOICE });
  assert.equal(sentFile(direct.calls[0]), 'Scan of all papers.pdf');

  // Any other request too big for the proxy is not sent (the proxy would refuse it and still count the call).
  const never = fakeFetch(() => ok({ ok: true }));
  const client = createClient({ mode: 'proxy', proxyUrl: PROXY_URL, getAccessToken: async () => 'token', workspaceId: HOUSE, fetch: never, retryBaseMs: 0 });
  await assert.rejects(client.json({ messages: [{ role: 'user', content: 'x'.repeat(26 * 1024 * 1024) }] }), (err) => err.code === 'too_large');
  assert.equal(never.calls.length, 0);
});

test('a report number keeps no lab name or "No." in front, so the rules can check it', () => {
  for (const printed of ['GIA 2141 438 172', 'GIA2141438172', 'GIA No. 2141 438 172', 'Report No: 2141438172']) {
    const { reportNumber } = normalizeLine({ reportNumber: printed });
    assert.equal(reportNumber, '2141438172', printed);
    assert.equal(checkReportNumber('GIA', reportNumber).ok, true, printed);
  }
  assert.equal(normalizeLine({ reportNumber: 'IGI LG-612345678' }).reportNumber, 'LG-612345678', 'still found in the text as printed');
  assert.equal(normalizeLine({ reportNumber: 'No report' }).reportNumber, null);
  assert.equal(normalizeField({ key: 'lab.reportNumber', value: 'GIA 2141438172', confidence: 0.9 }).value, '2141438172');
});

test('natural or lab-grown is read the same way as the rules read it', () => {
  for (const said of ['natural', 'Lab-grown', 'earth-mined', 'HPHT treated natural', 'Natural (see label)', 'not lab-grown', 'CVD', 'mixed']) {
    assert.equal(normalizeField({ key: 'goods.nature', value: said, confidence: 0.9 })?.value ?? null, natureFromText(said), said);
    assert.equal(normalizeLine({ growth: said }).growth, natureFromText(said), said);
  }
  assert.equal(natureFromText('Natural (see label)'), 'natural', '"label" is not a lab');
});

test('a proxy that answers 400 model_not_allowed: the next model is tried, as for one that does not exist', async () => {
  const fetch = fakeFetch((body) => (body.model === AI_MODELS[0] ? fail(400, `Model not allowed: ${body.model}.`, 'model_not_allowed') : ok({ ok: true })));
  const ai = directAI(fetch);
  assert.equal((await ai.check()).ok, true);
  assert.deepEqual(fetch.calls.map((c) => c.body.model), [AI_MODELS[0], AI_MODELS[1]]);
});

test('an answer from the AI clears the last problem, and chats and emails it read say who read them', async () => {
  let down = true;
  const fetch = fakeFetch((body) => {
    if (down) return { status: 503, json: { error: { message: 'Service unavailable' } } };
    const name = body.response_format?.json_schema?.name;
    if (name === 'chat_reading') return ok({ relevant: [], requests: [], packing: [], refs: [] });
    if (name === 'email_reading') return ok({ relevant: [], requests: [], refs: [] });
    return ok({ ok: true });
  });
  const ai = directAI(fetch);
  await ai.readChat(CHAT);
  assert.equal(ai.lastError.code, 'server');
  down = false;
  const chat = await ai.readChat(CHAT);
  assert.equal(ai.lastError, null, 'the status bar stops saying the AI is unreachable');
  assert.equal(chat.readBy, `ai:${AI_MODELS[0]}`);
  assert.equal(chat.aiError, undefined);
  const email = await ai.readEmail({ from: 'a@example.test', subject: 'EXP/26-27/031', text: 'Please send the KP copy.' });
  assert.equal(email.readBy, `ai:${AI_MODELS[0]}`);
});

test('the reader is told where the insured and the number of packages go, and what natural means', () => {
  const insurance = extractPrompt({ fileName: 'ins.pdf', docType: 'insurance_certificate', family: 'insurance' });
  assert.match(insurance, /insurer\.name, insured\.name/);
  assert.match(insurance, /goes in insured\.name, never in consignee\.name/);
  for (const family of ['invoice', 'customs', 'air_waybill']) {
    assert.match(extractPrompt({ fileName: 'x.pdf', docType: 'other', family }), /goods\.packages/, family);
  }
  assert.match(extractPrompt({ fileName: 'awb.pdf', docType: 'air_waybill', family: 'air_waybill' }), /never the\s+stone count/);
  assert.match(READER_SYSTEM, /HPHT-treated or HPHT-processed natural stones are natural/);
});

test('the offline reader reads natural and lab-grown the way the rules do', () => {
  assert.equal(growthFrom('Natural diamond, not lab-grown'), 'natural');
  assert.equal(growthFrom('Non-synthetic'), 'natural');
  assert.equal(growthFrom('No CVD/HPHT'), 'natural');
  assert.equal(growthFrom('HPHT treated natural'), 'natural');
  assert.equal(growthFrom('CVD lab grown'), 'lab-grown');
  assert.equal(growthFrom('Natural', 'LG612345678'), 'lab-grown', 'an LG report number is lab-grown');
  assert.equal(growthFrom('Round 1.01 G VS1'), null);
  assert.equal(normalizeLine({ growth: 'not lab-grown' }).growth, 'natural');
});
