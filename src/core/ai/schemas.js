// JSON schemas for every structured answer the model gives, plus a tiny validator.
// OpenAI "strict" structured output needs: additionalProperties false on every object, and every property
// listed in required. Optional values are written as ["string", "null"] so the model can say null.

import { DOC_TYPES, FIELD_KEYS, PAPER_KINDS } from '../types.js';

const text = { type: 'string' };
const textOrNull = { type: ['string', 'null'] };
const numberOrNull = { type: ['number', 'null'] };
const intOrNull = { type: ['integer', 'null'] };

/** Make a strict object schema: every property required, nothing extra allowed. */
export function strictObject(properties, description) {
  const schema = { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
  if (description) schema.description = description;
  return schema;
}

export const LINE_PROPERTIES = {
  lineNo: { ...intOrNull, description: 'Serial number printed on the row, or the row position' },
  description: { ...textOrNull, description: 'Goods description on the row, as printed' },
  reportNumber: { ...textOrNull, description: 'Grading report number without spaces, e.g. 2141438167 or LG612345678' },
  lab: { ...textOrNull, description: 'GIA, IGI, HRD, GCAL... only if printed or clear from the report' },
  shape: { ...textOrNull, description: 'Shape as printed, e.g. Round, RD, Oval' },
  carat: { ...numberOrNull, description: 'Carat weight of the stone or lot' },
  color: { ...textOrNull, description: 'Colour grade, e.g. G or G-H' },
  clarity: { ...textOrNull, description: 'Clarity grade, e.g. VS1' },
  pieces: { ...intOrNull, description: 'Number of stones on the row, only if printed' },
  rate: { ...numberOrNull, description: 'Price per carat' },
  amount: { ...numberOrNull, description: 'Row amount' },
  growth: { type: ['string', 'null'], enum: ['natural', 'lab-grown', null], description: 'Only with evidence' },
  quote: { ...textOrNull, description: 'The row text exactly as printed' },
};
export const LINE_SCHEMA = strictObject(LINE_PROPERTIES);

export const FIELD_SCHEMA = strictObject({
  key: { type: 'string', enum: FIELD_KEYS },
  value: { ...textOrNull, description: 'Normalized value: dates yyyy-mm-dd, carats plain decimal, null when absent' },
  quote: { ...textOrNull, description: 'The exact characters printed on the page for this value' },
  page: { ...intOrNull, description: 'Page number, starting at 1' },
  confidence: { type: 'number', description: '0 to 1' },
});

export const EXTRACTION_SCHEMA = strictObject({
  docType: { type: 'string', enum: DOC_TYPES },
  summary: { ...text, description: 'One plain sentence: what the paper is, number, date, parties, total' },
  fields: { type: 'array', items: FIELD_SCHEMA },
  lines: { type: 'array', items: LINE_SCHEMA },
  declarations: { type: 'array', items: text, description: 'Declaration sentences copied exactly' },
});

export const CLASSIFY_SCHEMA = strictObject({
  docType: { type: 'string', enum: DOC_TYPES },
  confidence: { type: 'number', description: '0 to 1' },
  reason: { ...text, description: 'A few words: the title or clue you used' },
});

// Chat answers point back at message numbers so we can copy the original text, author and time ourselves.
export const CHAT_SCHEMA = strictObject({
  relevant: {
    type: 'array',
    items: strictObject({ index: { type: 'integer' }, why: text }),
  },
  requests: {
    type: 'array',
    items: strictObject({ index: { type: 'integer' }, ref: textOrNull }),
  },
  packing: {
    type: 'array',
    items: strictObject({ index: { type: 'integer' }, ref: textOrNull, lines: { type: 'array', items: LINE_SCHEMA } }),
  },
  refs: { type: 'array', items: text },
});

export const EMAIL_SCHEMA = strictObject({
  relevant: { type: 'array', items: strictObject({ text, why: text }) },
  requests: { type: 'array', items: strictObject({ text, ref: textOrNull }) },
  refs: { type: 'array', items: text },
});

export const ROUTE_INTENTS = ['prepare_papers', 'whats_missing', 'build_packing_list', 'status', 'explain', 'other'];

export const ROUTE_SCHEMA = strictObject({
  intent: { type: 'string', enum: ROUTE_INTENTS },
  shipmentRef: { ...textOrNull, description: 'Ref of the shipment meant, copied from the list, or null' },
  kinds: { type: 'array', items: { type: 'string', enum: PAPER_KINDS } },
  reply: { ...text, description: 'One or two short plain sentences for the clerk' },
});

export const PACKING_SCHEMA = strictObject({
  lines: {
    type: 'array',
    items: strictObject({ source: { ...text, description: 'Tag of the material line, e.g. C3 or D2-4' }, ...LINE_PROPERTIES }),
  },
  notes: text,
});

export const PING_SCHEMA = strictObject({ ok: { type: 'boolean' } });

export const SCHEMAS = {
  extraction: EXTRACTION_SCHEMA,
  classification: CLASSIFY_SCHEMA,
  chat_reading: CHAT_SCHEMA,
  email_reading: EMAIL_SCHEMA,
  route: ROUTE_SCHEMA,
  packing_list: PACKING_SCHEMA,
  ping: PING_SCHEMA,
};

/**
 * Check a value against one of the schemas above. Returns a list of problems (empty when valid).
 * Supports only what our schemas use: type (string or list), enum, properties, required,
 * additionalProperties false and items.
 */
export function validate(schema, value, path = '$') {
  const problems = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((t) => isType(value, t))) {
    problems.push(`${path} should be ${types.join(' or ')}`);
    return problems;
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${path} is not one of the allowed values`);
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    for (const key of schema.required || []) {
      if (!(key in value)) problems.push(`${path}.${key} is missing`);
    }
    for (const key of Object.keys(value)) {
      if (!(key in schema.properties)) {
        if (schema.additionalProperties === false) problems.push(`${path}.${key} is not allowed`);
      } else {
        problems.push(...validate(schema.properties[key], value[key], `${path}.${key}`));
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => problems.push(...validate(schema.items, item, `${path}[${i}]`)));
  }
  return problems.slice(0, 20);
}

function isType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type; // string, boolean
}

/** Every place where a schema breaks the strict rules. Used by the tests; empty means the schema is strict. */
export function strictProblems(schema, path = '$') {
  const problems = [];
  if (schema.type === 'object' || schema.properties) {
    const keys = Object.keys(schema.properties || {});
    if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
    const required = schema.required || [];
    for (const key of keys) if (!required.includes(key)) problems.push(`${path}.${key}: not in required`);
    for (const key of keys) problems.push(...strictProblems(schema.properties[key], `${path}.${key}`));
  }
  if (schema.items) problems.push(...strictProblems(schema.items, `${path}[]`));
  return problems;
}
