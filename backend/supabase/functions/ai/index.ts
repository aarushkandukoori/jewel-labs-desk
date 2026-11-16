// Jewel Labs AI proxy (Supabase Edge Function, Deno).
//
// The desktop app sends an OpenAI Chat Completions request here instead of calling OpenAI itself, so no AI key ever
// ships in the app. Headers: Authorization: Bearer <the person's Supabase access token>, x-jl-workspace: <house id>.
// This function:
//   1. checks the token (auth.getUser) and that the person belongs to the house (or is Jewel Labs desk staff),
//   2. allows only the models in AI_MODELS and counts the call against the house's daily cap (AI_DAILY_CAP),
//   3. forwards the request to OpenAI with the OPENAI_API_KEY secret,
//   4. records the tokens used, and answers with OpenAI's own status and JSON.
// Errors from this function use OpenAI's error shape: { error: { message, type, code } }.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

// OPENAI_CHAT_URL is only for local tests; in production the default is used.
const OPENAI_URL = Deno.env.get('OPENAI_CHAT_URL') || 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODELS = 'gpt-5-mini,gpt-4.1-mini,gpt-4o-mini';
const DEFAULT_DAILY_CAP = 600;
const MAX_BODY_BYTES = 25 * 1024 * 1024; // page images are sent inline, so allow big bodies
const MAX_OUTPUT_TOKENS = 32000;
const OPENAI_TIMEOUT_MS = 140_000; // stay under the Edge Function time limit
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function dailyCap(): number {
  const cap = Number.parseInt(Deno.env.get('AI_DAILY_CAP') || '', 10);
  return Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_DAILY_CAP;
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

// Keep each call to one answer, as JSON, within a sane length, and never stored by OpenAI.
// deno-lint-ignore no-explicit-any
function tidyBody(body: Record<string, any>): void {
  delete body.stream;
  delete body.stream_options;
  delete body.store;
  if (body.n !== undefined && body.n !== null) body.n = 1;
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    if (typeof body[key] === 'number' && body[key] > MAX_OUTPUT_TOKENS) body[key] = MAX_OUTPUT_TOKENS;
  }
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
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY_BYTES) {
    return fail(413, 'This request is too large. Send fewer or smaller page images.', 'too_large');
  }
  // deno-lint-ignore no-explicit-any
  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'The request body is not valid JSON.', 'bad_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) {
    return fail(400, 'Send an OpenAI Chat Completions request with a messages list.', 'bad_request');
  }
  const models = allowedModels();
  if (!models.includes(body.model)) {
    return fail(400, `Model not allowed: ${String(body.model)}. Allowed: ${models.join(', ')}.`, 'model_not_allowed');
  }
  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  if (!openaiKey) return fail(500, 'The AI key is not set up on the server yet.', 'no_key');

  // The daily cap: count this call first, so many calls at once cannot slip past it.
  const cap = dailyCap();
  const { data: reserved, error: capError } = await admin.rpc('reserve_ai_call', {
    p_workspace: workspaceId,
    p_cap: cap,
  });
  if (capError) throw new Error(`reserve_ai_call failed: ${capError.message}`);
  if (!reserved) {
    return fail(429, `This house has used its ${cap} AI calls for today. The count resets at midnight UTC.`, 'daily_limit');
  }

  // 3. Forward to OpenAI.
  tidyBody(body);
  let upstream: Response;
  try {
    upstream = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
      p_input: usage.input,
      p_output: usage.output,
    });
    if (error) console.error('bump_ai_usage failed:', error.message);
  }
  console.log(JSON.stringify({ user: user.id, workspace: workspaceId, model: body.model, status: upstream.status, ...usage }));
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
