// Jewel Labs AI proxy (Supabase Edge Function, Deno).
//
// The desktop app sends an OpenAI Chat Completions request here instead of calling OpenAI itself, so no AI key ever
// ships in the app. Headers: Authorization: Bearer <the person's Supabase access token>, x-jl-workspace: <house id>.
// This function:
//   1. checks the token (auth.getUser) and that the person belongs to the house (or is Jewel Labs desk staff),
//   2. allows only the models in AI_MODELS and counts the call against the daily limits (reserve_ai_call): per house
//      (a small trial allowance until Jewel Labs approves the house) and per person, in calls and in tokens,
//   3. rebuilds the request from the few settings the app uses and forwards it with the OPENAI_API_KEY secret,
//   4. records the tokens used, and answers with OpenAI's own status and JSON.
// Errors from this function use OpenAI's error shape: { error: { message, type, code } }.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

// OPENAI_CHAT_URL is only for local tests; in production the default is used.
const OPENAI_URL = Deno.env.get('OPENAI_CHAT_URL') || 'https://api.openai.com/v1/chat/completions';
// Must include every model in src/core/config.js AI_MODELS. The AI_MODELS secret, when set, replaces this list.
const DEFAULT_MODELS = 'gpt-5.4-mini,gpt-5-mini,gpt-4.1-mini,gpt-4o-mini';
const MAX_BODY_BYTES = 25 * 1024 * 1024; // page images are sent inline, so allow big bodies
const MAX_OUTPUT_TOKENS = 16_000; // the app's longest answer (reading a whole document)
const REASONING_EFFORTS = ['none', 'minimal', 'low']; // what the app asks for; anything else becomes 'low'
const OPENAI_TIMEOUT_MS = 140_000; // stay under the Edge Function time limit
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Daily limits (UTC days), passed to reserve_ai_call. Each one can be changed with the secret named here.
const LIMITS: Record<string, [string, number]> = {
  p_house_calls: ['AI_DAILY_CAP', 600], // calls for a house Jewel Labs approved
  p_trial_calls: ['AI_TRIAL_DAILY_CAP', 50], // calls for a house not approved yet (made by self sign-up)
  p_user_calls: ['AI_USER_DAILY_CAP', 600], // calls for one person across all their houses (desk staff: no limit)
  p_house_tokens: ['AI_DAILY_TOKENS', 10_000_000], // input + output tokens, approved house
  p_trial_tokens: ['AI_TRIAL_DAILY_TOKENS', 1_000_000], // input + output tokens, house not approved yet
  p_user_tokens: ['AI_USER_DAILY_TOKENS', 10_000_000], // input + output tokens, one person (desk staff: no limit)
};

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

// Newer projects have named secret keys; older ones the legacy service role key. Either bypasses RLS.
function serviceKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    if (keys.default) return keys.default;
  } catch {
    // not set or not JSON: use the legacy key
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
}

const admin = createClient(Deno.env.get('SUPABASE_URL') || '', serviceKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

function fail(status: number, message: string, code: string): Response {
  return Response.json({ error: { message, type: 'jewel_labs_proxy', code } }, { status });
}

function allowedModels(): string[] {
  return (Deno.env.get('AI_MODELS') || DEFAULT_MODELS)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

function dailyLimits(): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const [param, [secret, fallback]] of Object.entries(LIMITS)) {
    const value = Number.parseInt(Deno.env.get(secret) || '', 10);
    limits[param] = Number.isFinite(value) && value >= 0 ? value : fallback;
  }
  return limits;
}

// What the person reads when reserve_ai_call says no.
function limitMessage(reason: string, limits: Record<string, number>): string {
  const resets = 'The count resets at midnight UTC.';
  const approve = 'Ask Jewel Labs to approve the house for the full allowance.';
  switch (reason) {
    case 'trial_calls':
      return `This house can make ${limits.p_trial_calls} AI calls a day until Jewel Labs approves it. ${approve} ${resets}`;
    case 'trial_tokens':
      return `This house has used its trial AI allowance for today. ${approve} ${resets}`;
    case 'house_calls':
      return `This house has used its ${limits.p_house_calls} AI calls for today. ${resets}`;
    case 'house_tokens':
      return `This house has used its AI allowance for today. ${resets}`;
    case 'user_calls':
      return `You have used your ${limits.p_user_calls} AI calls for today. ${resets}`;
    case 'user_tokens':
      return `You have used your AI allowance for today. ${resets}`;
    default:
      return `The AI cannot be used for this house right now. ${resets}`;
  }
}

// Members of the house, or desk users (Jewel Labs staff), may use the agents for it.
async function mayUseHouse(userId: string, workspaceId: string): Promise<boolean> {
  const member = await admin
    .from('members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (member.error) throw new Error(`members lookup failed: ${member.error.message}`);
  if (member.data) return true;
  const profile = await admin.from('profiles').select('is_desk').eq('user_id', userId).maybeSingle();
  if (profile.error) throw new Error(`profiles lookup failed: ${profile.error.message}`);
  return Boolean(profile.data?.is_desk);
}

// Reads the body, counting bytes as they arrive: a chunked upload has no Content-Length to check first.
// Returns null as soon as the body is larger than `limit`.
async function readBody(req: Request, limit: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// The answer length the caller asked for (max_completion_tokens, or the older max_tokens), at most
// MAX_OUTPUT_TOKENS. With no usable number, MAX_OUTPUT_TOKENS.
function answerLength(body: Json): number {
  const asked = body.max_completion_tokens ?? body.max_tokens;
  return Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS;
}

// The request OpenAI gets is rebuilt from the settings the app sends (src/core/ai/client.js): model, messages,
// response_format, temperature and reasoning_effort, with a capped answer length. Everything else is dropped
// (streaming, storing, several answers, tools, priority tier, ...), so the key can only be used to read papers.
// safety_identifier lets OpenAI tell one person's calls from another's (a hash, never the account itself).
function upstreamBody(body: Json, safetyIdentifier: string): Json {
  const out: Json = { model: body.model, messages: body.messages, max_completion_tokens: answerLength(body) };
  const format = body.response_format;
  if (format && typeof format === 'object' && !Array.isArray(format)) out.response_format = format;
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) out.temperature = body.temperature;
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null) {
    out.reasoning_effort = REASONING_EFFORTS.includes(body.reasoning_effort) ? body.reasoning_effort : 'low';
  }
  out.safety_identifier = safetyIdentifier;
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readUsage(text: string): { input: number; output: number } {
  try {
    const usage = JSON.parse(text)?.usage || {};
    return { input: Number(usage.prompt_tokens) || 0, output: Number(usage.completion_tokens) || 0 };
  } catch {
    return { input: 0, output: 0 };
  }
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return fail(405, 'Use POST.', 'method_not_allowed');

  // 1. Who is calling, and for which house?
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return fail(401, 'Sign in to use the agents.', 'not_signed_in');
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user) return fail(401, 'Your sign-in has expired. Sign in again.', 'bad_token');
  const workspaceId = (req.headers.get('x-jl-workspace') || '').trim();
  if (!UUID.test(workspaceId)) return fail(400, 'The x-jl-workspace header must be the house id.', 'bad_workspace');
  if (!(await mayUseHouse(user.id, workspaceId))) return fail(403, 'You are not a member of this house.', 'not_member');

  // 2. What is being asked?
  const tooLarge = () => fail(413, 'This request is too large. Send fewer or smaller page images.', 'too_large');
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY_BYTES) return tooLarge(); // no need to read it
  const bytes = await readBody(req, MAX_BODY_BYTES);
  if (!bytes) return tooLarge();
  let body: Json;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return fail(400, 'The request body is not valid JSON.', 'bad_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) {
    return fail(400, 'Send an OpenAI Chat Completions request with a messages list.', 'bad_request');
  }
  const models = allowedModels();
  if (!models.includes(body.model)) {
    // 404, as OpenAI answers for a model the account cannot use, so the app moves on to its next model.
    const asked = String(body.model).slice(0, 100);
    return fail(404, `Model not allowed: ${asked}. Allowed: ${models.join(', ')}.`, 'model_not_allowed');
  }
  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  if (!openaiKey) return fail(500, 'The AI key is not set up on the server yet.', 'no_key');

  // The daily limits: count this call first, so many calls at once cannot slip past them.
  const limits = dailyLimits();
  const { data: verdict, error: limitError } = await admin.rpc('reserve_ai_call', {
    p_workspace: workspaceId,
    p_user: user.id,
    ...limits,
  });
  if (limitError) throw new Error(`reserve_ai_call failed: ${limitError.message}`);
  if (verdict === 'no_house') return fail(403, 'This house was not found.', 'no_house');
  if (verdict !== 'ok') return fail(429, limitMessage(String(verdict), limits), 'daily_limit');

  // 3. Forward to OpenAI.
  const request = upstreamBody(body, await sha256Hex(user.id));
  let upstream: Response;
  try {
    upstream = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    return timedOut
      ? fail(504, 'OpenAI took too long to answer. Try again.', 'upstream_timeout')
      : fail(502, 'Could not reach OpenAI. Try again.', 'upstream_unreachable');
  }
  const text = await upstream.text();

  // 4. Record the tokens (never the content), then pass OpenAI's answer through as it is.
  const usage = readUsage(text);
  if (usage.input || usage.output) {
    const { error } = await admin.rpc('bump_ai_usage', {
      p_workspace: workspaceId,
      p_user: user.id,
      p_input: usage.input,
      p_output: usage.output,
    });
    if (error) console.error('bump_ai_usage failed:', error.message);
  }
  console.log(JSON.stringify({ user: user.id, workspace: workspaceId, model: request.model, status: upstream.status, ...usage }));
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error('ai proxy error:', err instanceof Error ? err.message : String(err));
    return fail(500, 'The AI service had a problem. Try again in a minute.', 'server_error');
  }
});
