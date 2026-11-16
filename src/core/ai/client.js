// OpenAI Chat Completions client. Two ways in:
//   direct: the house's own OpenAI key, straight to api.openai.com
//   proxy:  the Jewel Labs proxy (Supabase Edge Function) with the signed-in user's token.
//           Same request body, same response JSON, so the rest of the app does not care which one is used.
// The client picks a model (falling back down the list when one is not available), adjusts settings a model
// rejects, retries busy or failed calls, and turns errors into plain messages the app can show.

import { AI_MODELS, AI_REASONING, AI_MAX_PARALLEL } from '../config.js';
import { validate } from './schemas.js';

export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const RETRY_STATUSES = [429, 500, 502, 503, 504];
const MAX_WAIT_MS = 20_000;

/** An error the app can show as is. `code` says what kind it is: no_key, invalid_key, quota, rate_limit... */
export class AIError extends Error {
  constructor(code, message, { status = null, param = null, retryable = false, detail = '', retryAfterMs = null } = {}) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.status = status;
    this.param = param;
    this.retryable = retryable;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

export const NO_KEY_MESSAGE = 'No OpenAI key yet. Add one in Settings, or sign in to use the Jewel Labs AI.';

/** True when the API refused a PDF file part (some models and proxies only take text and images). */
export function isFileRejection(err) {
  if (!err || err.code !== 'bad_request') return false;
  return /\bfile\b|file_data|input_file|content\.type|unsupported (?:content|mime)|\bpdf\b/i.test(`${err.param || ''} ${err.detail || ''}`);
}

export function createClient({
  mode = 'direct',
  apiKey = '',
  proxyUrl = '',
  getAccessToken = null,
  workspaceId = null,
  model = null,
  models = AI_MODELS,
  fetch: fetchFn = globalThis.fetch,
  timeoutMs = 90_000,
  tries = 3,
  retryBaseMs = 1000,
  maxParallel = AI_MAX_PARALLEL,
  onUsage = () => {},
} = {}) {
  const modelList = [...new Set([model, ...models].filter(Boolean))];
  let modelIndex = 0; // the model that worked last time; later calls start there

  // What we learned about each model's settings. Filled in when the API rejects one of ours.
  const effortFor = {}; // model -> reasoning effort that works, or null for "send none"
  const tokenParamFor = {}; // model -> 'max_tokens' or 'max_completion_tokens'
  const tokenCapFor = {}; // model -> largest output the model allows
  const noTemperature = new Set();
  const jsonObjectOnly = new Set(); // models that only take { type: 'json_object' }

  let active = 0;
  const waiting = [];

  const url = mode === 'proxy' ? proxyUrl : OPENAI_URL;

  function currentModel() {
    return modelList[modelIndex];
  }

  // ---- request body ----

  function isReasoningModel(name) {
    return /^(?:gpt-5|o\d)/.test(name);
  }

  function buildBody(modelName, { messages, schema, name, maxTokens }) {
    const body = { model: modelName, messages };
    if (schema && jsonObjectOnly.has(modelName)) {
      body.response_format = { type: 'json_object' };
      const rule = `Answer with one JSON object only. It must follow this JSON schema: ${JSON.stringify(schema)}`;
      body.messages = [{ role: 'system', content: rule }, ...messages];
    } else if (schema) {
      body.response_format = { type: 'json_schema', json_schema: { name, strict: true, schema } };
    }
    const reasoning = isReasoningModel(modelName);
    const tokenParam = tokenParamFor[modelName] || (reasoning ? 'max_completion_tokens' : 'max_tokens');
    body[tokenParam] = Math.min(maxTokens, tokenCapFor[modelName] || Infinity);
    if (reasoning) {
      // GPT-5 family: no temperature; keep reasoning short because reading papers needs care, not long thought.
      const effort = modelName in effortFor ? effortFor[modelName] : (AI_REASONING[modelName] ?? 'minimal');
      if (effort) body.reasoning_effort = effort;
    } else if (!noTemperature.has(modelName)) {
      body.temperature = 0;
    }
    return body;
  }

  // When a model rejects one of our settings, change that setting and try again.
  function adjustForRejection(modelName, err, body) {
    const said = `${err.param || ''} ${err.detail || ''}`.toLowerCase();
    const cap = said.match(/at most (\d+)/);
    if (cap && /token/.test(said)) {
      tokenCapFor[modelName] = Number(cap[1]);
      return true;
    }
    if (body.reasoning_effort !== undefined && said.includes('reasoning_effort')) {
      effortFor[modelName] = body.reasoning_effort === 'low' ? null : 'low';
      return true;
    }
    if (body.max_tokens !== undefined && said.includes('max_tokens')) {
      tokenParamFor[modelName] = 'max_completion_tokens';
      return true;
    }
    if (body.max_completion_tokens !== undefined && said.includes('max_completion_tokens')) {
      tokenParamFor[modelName] = 'max_tokens';
      return true;
    }
    if (body.temperature !== undefined && said.includes('temperature')) {
      noTemperature.add(modelName);
      return true;
    }
    if (body.response_format?.type === 'json_schema' && /response_format|json_schema/.test(said)) {
      jsonObjectOnly.add(modelName);
      return true;
    }
    return false;
  }

  // ---- sending ----

  async function bearer() {
    if (mode === 'proxy') {
      let token = null;
      try {
        token = getAccessToken ? await getAccessToken() : null;
      } catch {
        token = null;
      }
      if (!token) throw new AIError('signed_out', 'Sign in to Jewel Labs to use the AI.');
      return token;
    }
    if (!apiKey) throw new AIError('no_key', NO_KEY_MESSAGE);
    return apiKey;
  }

  async function errorFromResponse(res) {
    let info = {};
    try {
      const data = await res.json();
      info = data?.error ?? data ?? {};
    } catch {
      info = {};
    }
    if (typeof info === 'string') info = { message: info };
    const status = res.status;
    const code = String(info.code || info.type || '');
    const raw = String(info.message || `HTTP ${status}`);
    const opts = { status, param: info.param || null, detail: raw };
    const service = mode === 'proxy' ? 'The Jewel Labs AI service' : 'OpenAI';
    if (code === 'model_not_found' || status === 404) {
      return new AIError('model_unavailable', `This model is not available: ${raw}`, opts);
    }
    if (status === 401) {
      return mode === 'proxy'
        ? new AIError('signed_out', 'Your Jewel Labs sign-in has expired. Sign in again.', opts)
        : new AIError('invalid_key', 'The OpenAI key was not accepted. Check the key in Settings.', opts);
    }
    if (status === 402 || code === 'insufficient_quota' || (status === 429 && /quota|billing/i.test(raw))) {
      const message = mode === 'proxy'
        ? 'The AI allowance for this house is used up. Contact Jewel Labs to raise it.'
        : 'The OpenAI account is out of credit. Add credit in OpenAI billing, then try again.';
      return new AIError('quota', message, opts);
    }
    if (status === 429) {
      return new AIError('rate_limit', `${service} is busy right now. The agents will try again.`, {
        ...opts, retryable: true, retryAfterMs: retryAfterMs(res),
      });
    }
    if (status === 403) return new AIError('forbidden', `${service} refused the request: ${raw}`, opts);
    if (status === 413) return new AIError('too_large', 'This document is too large to send to the AI.', opts);
    if (status === 400 || status === 422) return new AIError('bad_request', `${service} could not use the request: ${raw}`, opts);
    if (status >= 500) {
      return new AIError('server', `${service} had a server problem. The agents will try again.`, {
        ...opts, retryable: RETRY_STATUSES.includes(status),
      });
    }
    return new AIError('http_error', `${service} answered ${status}: ${raw}`, opts);
  }

  // The proxy counts each call against one house, named by the x-jl-workspace header (a string or a function).
  async function headersFor(token) {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    if (mode !== 'proxy') return headers;
    const house = typeof workspaceId === 'function' ? await workspaceId() : workspaceId;
    if (!house) throw new AIError('no_house', 'Open a shared house first: the Jewel Labs AI works for one house at a time.');
    return { ...headers, 'x-jl-workspace': String(house) };
  }

  async function sendOnce(body) {
    const token = await bearer();
    const headers = await headersFor(token);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      const data = await res.json();
      onUsage(data?.usage || {}, body.model);
      return data;
    } catch (err) {
      if (err instanceof AIError) throw err;
      if (controller.signal.aborted) {
        throw new AIError('timeout', 'The AI took too long to answer. The agents will try again.', { retryable: true });
      }
      const where = mode === 'proxy' ? 'the Jewel Labs AI service' : 'OpenAI';
      throw new AIError('network', `Could not reach ${where}. Check the internet connection.`, {
        retryable: true, detail: String(err?.message || err),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // At most maxParallel calls in flight; the rest wait their turn (keeps us under rate limits).
  async function limited(task) {
    if (active < maxParallel) active += 1;
    else await new Promise((resolve) => waiting.push(resolve)); // the slot is handed over on release
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  }

  async function sendWithRetries(body) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await limited(() => sendOnce(body));
      } catch (err) {
        if (!err.retryable || attempt >= tries) throw err;
        await wait(backoffMs(attempt, err));
      }
    }
  }

  function backoffMs(attempt, err) {
    if (retryBaseMs <= 0) return 0;
    const planned = retryBaseMs * 2 ** (attempt - 1) + Math.random() * retryBaseMs * 0.25;
    return Math.min(err.retryAfterMs ?? planned, MAX_WAIT_MS);
  }

  async function completeWithModel(modelName, request) {
    for (let adjustments = 0; ; adjustments += 1) {
      const body = buildBody(modelName, request);
      try {
        return await sendWithRetries(body);
      } catch (err) {
        if (err.code === 'bad_request' && adjustments < 5 && adjustForRejection(modelName, err, body)) continue;
        throw err;
      }
    }
  }

  /** One Chat Completions call. Falls back to the next model on 404 / model_not_found and remembers it. */
  async function complete(request) {
    if (mode === 'direct' && !apiKey) throw new AIError('no_key', NO_KEY_MESSAGE);
    if (mode === 'proxy' && !proxyUrl) throw new AIError('no_proxy', 'The Jewel Labs AI service address is missing.');
    const tried = [];
    while (modelIndex < modelList.length) {
      const modelName = modelList[modelIndex];
      try {
        const data = await completeWithModel(modelName, request);
        return { data, model: modelName };
      } catch (err) {
        if (err.code !== 'model_unavailable') throw err;
        tried.push(modelName);
        modelIndex += 1;
      }
    }
    modelIndex = 0; // start over next time, the account may gain access later
    throw new AIError('model_unavailable', `None of these models are available on this account: ${tried.join(', ')}.`);
  }

  /**
   * Ask for a structured answer. Returns { value, model } where value already matches the schema.
   * If the answer is not valid JSON for the schema, asks once more with a note saying what was wrong.
   */
  async function json({ messages, schema, name, maxTokens = 4000 }) {
    let answer = await complete({ messages, schema, name, maxTokens });
    let parsed = readAnswer(answer.data, schema);
    if (parsed.ok) return { value: parsed.value, model: answer.model };
    const repair = [...messages];
    if (parsed.raw && !parsed.cutOff) repair.push({ role: 'assistant', content: parsed.raw.slice(0, 4000) });
    repair.push({
      role: 'user',
      content: parsed.cutOff
        ? 'Your answer was cut off. Answer again with complete JSON: keep quotes short and the summary to one sentence.'
        : `Your answer did not match the JSON schema (${parsed.error}). Answer again with JSON only.`,
    });
    answer = await complete({ messages: repair, schema, name, maxTokens });
    parsed = readAnswer(answer.data, schema);
    if (parsed.ok) return { value: parsed.value, model: answer.model };
    throw new AIError('bad_json', 'The AI answer could not be read. The agents will try again later.', { detail: parsed.error });
  }

  return {
    mode,
    get model() {
      return currentModel();
    },
    complete,
    json,
  };
}

/** Pull the JSON out of a Chat Completions response and check it. */
export function readAnswer(response, schema) {
  const choice = response?.choices?.[0];
  const message = choice?.message || {};
  if (message.refusal) {
    throw new AIError('refused', 'The AI would not read this. A person needs to look at it.', { detail: String(message.refusal) });
  }
  const raw = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content) ? message.content.map((part) => part?.text || '').join('') : '';
  const cutOff = choice?.finish_reason === 'length';
  let value;
  try {
    value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    return { ok: false, raw, cutOff, error: cutOff ? 'the answer was cut off' : 'the answer was not JSON' };
  }
  const problems = schema ? validate(schema, value) : [];
  if (problems.length) return { ok: false, raw, cutOff, error: problems.slice(0, 5).join('; ') };
  return { ok: true, value };
}

function retryAfterMs(res) {
  const ms = Number(res.headers?.get?.('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const seconds = Number(res.headers?.get?.('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return null;
}

function wait(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
