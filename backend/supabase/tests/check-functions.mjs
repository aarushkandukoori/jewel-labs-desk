// Runs the ai and signup Edge Functions under Deno against a local stand-in for Supabase and OpenAI, and checks
// how they answer (sign-in checks, house membership, model list, what is forwarded to OpenAI, body size, daily
// limits, sign-up rules, desk invites, rate limit, logs).
// Nothing leaves this computer and nothing is downloaded: the functions use the supabase-js copy already in
// node_modules. Needs Deno (https://deno.com). Run: node backend/supabase/tests/check-functions.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (spawnSync('deno', ['--version']).error) {
  console.error('Deno is not installed. Install it from https://deno.com, then run this again.');
  process.exit(2);
}

// A scratch folder with the two functions and a link to the repo's node_modules, so Deno needs no network.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-functions-'));
await fs.copyFile(path.join(here, '..', 'functions', 'ai', 'index.ts'), path.join(dir, 'ai.ts'));
await fs.copyFile(path.join(here, '..', 'functions', 'signup', 'index.ts'), path.join(dir, 'signup.ts'));
await fs.symlink(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
const supabaseVersion = JSON.parse(await fs.readFile(path.join(repoRoot, 'node_modules', '@supabase', 'supabase-js', 'package.json'), 'utf8')).version;
await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@supabase/supabase-js': supabaseVersion } }));
await fs.writeFile(path.join(dir, 'deno.json'), JSON.stringify({ nodeModulesDir: 'manual' }));
process.on('exit', () => rmSync(dir, { recursive: true, force: true })); // the link is removed, not what it points to

const check = spawnSync('deno', ['check', '--cached-only', 'ai.ts', 'signup.ts'], { cwd: dir, encoding: 'utf8', env: { ...process.env, DENO_NO_UPDATE_CHECK: '1' } });
if (check.status !== 0) {
  console.error(check.stdout, check.stderr);
  throw new Error('deno check failed');
}
console.log('ok - both functions pass the TypeScript check');

const WS = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const MEMBER = '44444444-4444-4444-8444-444444444444';
const DESK = '55555555-5555-4555-8555-555555555555';
const tokens = { 'member-token': MEMBER, 'desk-token': DESK };
const SERVICE_KEY = ['test', 'service', 'key'].join('-');
const OPENAI_KEY = ['test', 'openai', 'key'].join('-');

// ---------- the stand-in ----------
const log = [];
let aiCalls = 0;
let nextVerdict = null; // reserve_ai_call's answer for the next call, when a test wants a particular limit
let allowSignupTries = true;
let signupCounterFails = false;
let redeemWorks = true;
const users = new Map([['taken@sample.example', { id: '66666666-6666-4666-8666-666666666666' }]]);
const deleted = [];
let lastOpenAIBody = null;
let openAICalls = 0;
const inviteRows = {
  ABCDEFGH: { role: 'preparer', email: null },
  DESKABCD: { role: 'desk', email: 'hire@sample.example' }, // a desk invite for one person
  DESKWXYZ: { role: 'desk', email: null }, // a desk invite from before 0005
};

const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  const body = text ? JSON.parse(text) : null;
  const url = new URL(req.url, 'http://local');
  const q = Object.fromEntries(url.searchParams);
  log.push({ method: req.method, path: url.pathname, q, body, auth: req.headers.authorization });
  const send = (status, json) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(json === undefined ? '' : JSON.stringify(json));
  };
  const p = url.pathname;
  if (p === '/auth/v1/user') {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    return tokens[token] ? send(200, { id: tokens[token], email: 'x@sample.example', aud: 'authenticated' }) : send(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
  }
  if (p === '/auth/v1/admin/users' && req.method === 'POST') {
    if (users.has(body.email)) return send(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
    const user = { id: `77777777-7777-4777-8777-${String(users.size).padStart(12, '0')}`, email: body.email, user_metadata: body.user_metadata };
    users.set(body.email, user);
    assert.equal(body.email_confirm, true, 'accounts are created confirmed');
    return send(200, user);
  }
  if (p.startsWith('/auth/v1/admin/users/') && req.method === 'GET') return send(200, { id: p.split('/').pop(), email: 'x@sample.example' });
  if (p.startsWith('/auth/v1/admin/users/') && req.method === 'DELETE') {
    deleted.push(p.split('/').pop());
    return send(200, {});
  }
  if (p === '/rest/v1/members') return send(200, q.user_id === `eq.${MEMBER}` && q.workspace_id === `eq.${WS}` ? [{ role: 'preparer' }] : []);
  if (p === '/rest/v1/profiles' && req.method === 'GET') return send(200, q.user_id === `eq.${DESK}` ? [{ is_desk: true }] : [{ is_desk: false }]);
  if (p === '/rest/v1/profiles' && req.method === 'POST') return send(201);
  if (p === '/rest/v1/rpc/reserve_ai_call') {
    if (nextVerdict) {
      const verdict = nextVerdict;
      nextVerdict = null;
      return send(200, verdict);
    }
    aiCalls += 1;
    return send(200, aiCalls <= body.p_house_calls ? 'ok' : 'house_calls');
  }
  if (p === '/rest/v1/rpc/bump_ai_usage') return send(204);
  if (p === '/rest/v1/rpc/note_signup_attempt') {
    return signupCounterFails ? send(500, { code: 'XX000', message: 'counter is down' }) : send(200, allowSignupTries);
  }
  if (p === '/rest/v1/invites') {
    const row = inviteRows[String(q.code || '').replace(/^eq\./, '')];
    return send(200, row ? [{ ...row, expires_at: new Date(Date.now() + 86400000).toISOString(), uses: 0, max_uses: 20 }] : []);
  }
  if (p === '/rest/v1/rpc/redeem_invite') return send(200, redeemWorks ? WS : null);
  if (p === '/rest/v1/rpc/create_house_for') return send(200, { id: OTHER, name: body.p_payload.name, environment: 'sandbox' });
  if (p === '/openai') {
    assert.equal(req.headers.authorization, `Bearer ${OPENAI_KEY}`);
    lastOpenAIBody = body;
    openAICalls += 1;
    if (body.messages[0].content === 'make OpenAI fail') return send(400, { error: { message: 'Bad request from OpenAI', type: 'invalid_request_error' } });
    return send(200, { id: 'chatcmpl-sample', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '{"docType":"lab_report"}' } }], usage: { prompt_tokens: 120, completion_tokens: 30 } });
  }
  send(404, { message: `no route ${req.method} ${p}` });
});
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const fakeUrl = `http://127.0.0.1:${fake.address().port}`;

// ---------- running a function under Deno ----------
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startFunction(file, env) {
  const port = await freePort();
  const child = spawn('deno', ['run', '--cached-only', '--allow-net', '--allow-env', file], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DENO_NO_UPDATE_CHECK: '1',
      DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}`,
      SUPABASE_URL: fakeUrl,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  for (let i = 0; i < 200; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });
      return { url: `http://127.0.0.1:${port}`, stop: () => child.kill(), output: () => output };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill();
  throw new Error(`function did not start:\n${output}`);
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// Sends only the headers of a POST (fetch would refuse a Content-Length that does not match the body) and
// returns the answer the server gives without waiting for a body.
function headersOnly(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        req.destroy();
        resolve({ status: res.statusCode, text });
      });
    });
    req.on('error', reject);
    req.flushHeaders();
  });
}
const ok = (label) => console.log(`ok - ${label}`);

// ---------- ai ----------
const ai = await startFunction('ai.ts', { OPENAI_API_KEY: OPENAI_KEY, OPENAI_CHAT_URL: `${fakeUrl}/openai`, AI_DAILY_CAP: '5', AI_TRIAL_DAILY_CAP: '7' });
try {
  // Everything a caller could add to use the Jewel Labs key for something else.
  const extras = {
    stream: true, stream_options: { include_usage: true }, store: true, n: 4, tools: [{ type: 'function', function: { name: 'x' } }],
    service_tier: 'priority', metadata: { a: 'b' }, user: 'someone', prediction: { type: 'content', content: 'x' }, logit_bias: { 1: 5 },
    verbosity: 'high', max_tokens: 50,
  };
  const request = { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'Classify this page' }], reasoning_effort: 'high', max_completion_tokens: 999999, ...extras };
  const member = { Authorization: 'Bearer member-token', 'x-jl-workspace': WS };

  let r = await fetch(ai.url, { method: 'GET' });
  assert.equal(r.status, 405); ok('ai: GET is refused');
  r = await post(ai.url, request, { 'x-jl-workspace': WS });
  assert.equal(r.status, 401); assert.equal((await r.json()).error.code, 'not_signed_in'); ok('ai: no token, 401');
  r = await post(ai.url, request, { Authorization: 'Bearer stolen', 'x-jl-workspace': WS });
  assert.equal(r.status, 401); assert.equal((await r.json()).error.code, 'bad_token'); ok('ai: bad token, 401');
  r = await post(ai.url, request, { Authorization: 'Bearer member-token', 'x-jl-workspace': 'not-a-uuid' });
  assert.equal(r.status, 400); ok('ai: bad house header, 400');
  r = await post(ai.url, request, { Authorization: 'Bearer member-token', 'x-jl-workspace': OTHER });
  assert.equal(r.status, 403); assert.equal((await r.json()).error.code, 'not_member'); ok('ai: not a member, 403');
  r = await post(ai.url, { ...request, model: 'gpt-4.5-preview' }, member);
  assert.equal(r.status, 404); assert.equal((await r.json()).error.code, 'model_not_allowed');
  ok('ai: model outside the list, 404 (as OpenAI answers), so the app tries its next model');
  r = await post(ai.url, { model: 'gpt-5-mini' }, member);
  assert.equal(r.status, 400); ok('ai: no messages, 400');
  const declared = await headersOnly(ai.url, { ...member, 'content-type': 'application/json', 'content-length': String(26 * 1024 * 1024) });
  assert.equal(declared.status, 413);
  ok('ai: a declared body over 25 MB is refused before it is read');
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const chunked = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 26; i += 1) controller.enqueue(chunk);
      controller.close();
    },
  });
  r = await fetch(ai.url, { method: 'POST', headers: { ...member, 'content-type': 'application/json' }, body: chunked, duplex: 'half' }).catch((err) => err);
  // The server may answer and close before the client finishes sending, which the client reports as an error.
  assert.ok(r instanceof Error || r.status === 413, `a chunked body over 25 MB is refused (got ${r.status})`);
  ok(`ai: a chunked body over 25 MB is refused while it is read (${r instanceof Error ? 'closed early' : r.status})`);
  assert.equal(aiCalls, 0, 'nothing was counted for refused requests');
  assert.equal(openAICalls, 0, 'nothing reached OpenAI for refused requests');

  r = await post(ai.url, request, member);
  assert.equal(r.status, 200);
  const answer = await r.json();
  assert.equal(answer.choices[0].message.content, '{"docType":"lab_report"}');
  ok('ai: a member gets OpenAI\'s answer as it is');
  assert.deepEqual(Object.keys(lastOpenAIBody).sort(), ['max_completion_tokens', 'messages', 'model', 'reasoning_effort', 'safety_identifier']);
  assert.equal(lastOpenAIBody.max_completion_tokens, 16000);
  assert.equal(lastOpenAIBody.reasoning_effort, 'low');
  assert.match(lastOpenAIBody.safety_identifier, /^[0-9a-f]{64}$/);
  assert.notEqual(lastOpenAIBody.safety_identifier, MEMBER);
  ok('ai: the request is rebuilt: only the app\'s settings, answer length capped at 16000, no tools/stream/store/tier');
  const reserve = log.filter((l) => l.path === '/rest/v1/rpc/reserve_ai_call').at(-1);
  assert.deepEqual(reserve.body, {
    p_workspace: WS, p_user: MEMBER, p_house_calls: 5, p_trial_calls: 7, p_user_calls: 600,
    p_house_tokens: 10000000, p_trial_tokens: 1000000, p_user_tokens: 10000000,
  });
  ok('ai: the call is counted for the house and the person, with the limits from the secrets or their defaults');
  const bump = log.filter((l) => l.path === '/rest/v1/rpc/bump_ai_usage').at(-1);
  assert.deepEqual(bump.body, { p_workspace: WS, p_user: MEMBER, p_input: 120, p_output: 30 });
  assert.equal(bump.auth, `Bearer ${SERVICE_KEY}`);
  ok('ai: tokens are recorded for the house and the person, with the service key');

  const appRequest = {
    model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'Read this page' }], reasoning_effort: 'none',
    response_format: { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: { type: 'object' } } },
  };
  r = await post(ai.url, appRequest, member);
  assert.equal(r.status, 200, 'gpt-5.4-mini (the app\'s first model) is allowed by default');
  assert.deepEqual(lastOpenAIBody.response_format, appRequest.response_format);
  assert.equal(lastOpenAIBody.reasoning_effort, 'none');
  assert.equal(lastOpenAIBody.max_completion_tokens, 16000, 'no length asked: the cap');
  r = await post(ai.url, { model: 'gpt-4.1-mini', messages: appRequest.messages, temperature: 0, max_tokens: 400 }, member);
  assert.equal(r.status, 200);
  assert.deepEqual({ ...lastOpenAIBody, safety_identifier: undefined }, { model: 'gpt-4.1-mini', messages: appRequest.messages, temperature: 0, max_completion_tokens: 400, safety_identifier: undefined });
  ok('ai: what the app sends goes through as it is (gpt-5.4-mini, json schema, reasoning none, temperature, max_tokens)');

  r = await post(ai.url, request, { Authorization: 'Bearer desk-token', 'x-jl-workspace': WS });
  assert.equal(r.status, 200); ok('ai: a desk user may work on any house');
  r = await post(ai.url, { ...request, messages: [{ role: 'user', content: 'make OpenAI fail' }] }, member);
  assert.equal(r.status, 400); assert.equal((await r.json()).error.message, 'Bad request from OpenAI'); ok('ai: OpenAI errors pass through with their status');
  nextVerdict = 'trial_calls';
  r = await post(ai.url, request, member);
  let refusal = (await r.json()).error;
  assert.equal(r.status, 429); assert.equal(refusal.code, 'daily_limit'); assert.match(refusal.message, /7 AI calls a day until Jewel Labs approves it/);
  nextVerdict = 'user_tokens';
  r = await post(ai.url, request, member);
  refusal = (await r.json()).error;
  assert.equal(r.status, 429); assert.match(refusal.message, /You have used your AI allowance/);
  ok('ai: trial and per-person limits answer 429 daily_limit with a plain reason');
  nextVerdict = 'no_house';
  r = await post(ai.url, request, { Authorization: 'Bearer desk-token', 'x-jl-workspace': OTHER });
  assert.equal(r.status, 403); ok('ai: a house that does not exist, 403');
  r = await post(ai.url, request, member);
  assert.equal(r.status, 429); assert.equal((await r.json()).error.code, 'daily_limit'); ok('ai: the daily cap answers 429');
  assert.ok(!ai.output().includes('Classify this page'), 'request content is never logged');
  ok('ai: logs carry no request content');
} finally {
  ai.stop();
}

const aiNoKey = await startFunction('ai.ts', { OPENAI_CHAT_URL: `${fakeUrl}/openai` });
try {
  const r = await post(aiNoKey.url, { model: 'gpt-5-mini', messages: [] }, { Authorization: 'Bearer member-token', 'x-jl-workspace': WS });
  assert.equal(r.status, 500); assert.equal((await r.json()).error.code, 'no_key'); ok('ai: a missing OpenAI key is a clear 500');
} finally {
  aiNoKey.stop();
}

// ---------- signup ----------
const signup = await startFunction('signup.ts', {});
try {
  const form = { email: 'New.Clerk@Sample.example', password: 'a long sample password', name: 'SAMPLE Clerk' };
  let r = await post(signup.url, { ...form, email: 'not-an-email' });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /valid email/); ok('signup: bad email, 400');
  r = await post(signup.url, { ...form, password: 'short' });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /at least 8/); ok('signup: short password, 400');
  r = await post(signup.url, { ...form, name: '' });
  assert.equal(r.status, 400); ok('signup: no name, 400');
  r = await post(signup.url, { ...form, inviteCode: 'BAD' });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /8 letters/); ok('signup: malformed code, 400');
  r = await post(signup.url, { ...form, email: 'taken@sample.example' });
  assert.equal(r.status, 409); assert.match((await r.json()).error, /already exists/); ok('signup: taken email, 409');

  r = await post(signup.url, form);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, workspaceId: OTHER });
  const house = log.filter((l) => l.path === '/rest/v1/rpc/create_house_for').at(-1).body;
  assert.equal(house.p_payload.name, "SAMPLE Clerk's house");
  assert.ok(users.has('new.clerk@sample.example'), 'email is stored in lower case');
  ok('signup: without a code, a confirmed account and its own sandbox house');

  r = await post(signup.url, { ...form, email: 'second@sample.example', inviteCode: 'abcd-efgh' });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, workspaceId: WS }); ok('signup: with a valid code, joins that house');
  r = await post(signup.url, { ...form, email: 'third@sample.example', inviteCode: 'ZZZZZZZZ' });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /not valid or has expired/); ok('signup: unknown code, 400, no account made');
  assert.ok(!users.has('third@sample.example'));

  redeemWorks = false; // the last place on the code was taken a moment ago
  r = await post(signup.url, { ...form, email: 'fourth@sample.example', inviteCode: 'ABCDEFGH' });
  assert.equal(r.status, 400);
  assert.equal(deleted.length, 1, "the half-made account was removed");
  ok('signup: a code used up in a race removes the new account');
  redeemWorks = true;

  allowSignupTries = false;
  r = await post(signup.url, { ...form, email: 'fifth@sample.example' });
  assert.equal(r.status, 429); ok('signup: too many tries from one network, 429');
  allowSignupTries = true;
  const lastAttempt = () => log.filter((l) => l.path === '/rest/v1/rpc/note_signup_attempt').at(-1).body;
  const attempt = lastAttempt();
  assert.match(attempt.p_ip_hash, /^[0-9a-f]{64}$/); ok('signup: only a hash of the network address is stored');
  assert.equal(attempt.p_limit, 10); assert.equal(attempt.p_global_limit, 100);
  ok('signup: 10 tries an hour per network, and 100 an hour for all networks together');

  // The address comes from cf-connecting-ip (set by the platform), not from X-Forwarded-For (written by the caller).
  const hashOf = (address) => createHash('sha256').update(`jl-signup:${address}`).digest('hex');
  await post(signup.url, { ...form, email: 'net1@sample.example' }, { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' });
  const first = lastAttempt().p_ip_hash;
  await post(signup.url, { ...form, email: 'net2@sample.example' }, { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.2' });
  assert.equal(first, hashOf('203.0.113.7'));
  assert.equal(lastAttempt().p_ip_hash, first, 'a new X-Forwarded-For value does not give a new allowance');
  await post(signup.url, { ...form, email: 'net3@sample.example' }, { 'x-forwarded-for': '198.51.100.3, 203.0.113.9' });
  assert.equal(lastAttempt().p_ip_hash, hashOf('198.51.100.3'), 'without cf-connecting-ip: the first X-Forwarded-For entry');
  ok('signup: the rate limit uses the address the platform sets');

  signupCounterFails = true;
  r = await post(signup.url, { ...form, email: 'counter@sample.example' });
  assert.equal(r.status, 500);
  assert.ok(!users.has('counter@sample.example'));
  signupCounterFails = false;
  ok('signup: when the counter cannot be read, nobody signs up (fails closed)');

  r = await post(signup.url, { ...form, email: 'someone@sample.example', inviteCode: 'DESKABCD' });
  assert.equal(r.status, 400); assert.ok(!users.has('someone@sample.example'));
  ok('signup: a desk invite for another email, 400, no account made');
  r = await post(signup.url, { ...form, email: 'Hire@Sample.example', inviteCode: 'DESKABCD' });
  assert.equal(r.status, 200); ok('signup: a desk invite works for the email it names');
  r = await post(signup.url, { ...form, email: 'old.desk@sample.example', inviteCode: 'DESKWXYZ' });
  assert.equal(r.status, 400); assert.ok(!users.has('old.desk@sample.example'));
  ok('signup: a desk invite that names nobody (made before 0005) no longer works');

  assert.ok(!signup.output().includes('a long sample password'), 'passwords never reach the logs');
  ok('signup: passwords never reach the logs');
} finally {
  signup.stop();
}

const closed = await startFunction('signup.ts', { ALLOW_OPEN_SIGNUP: 'false' });
try {
  const r = await post(closed.url, { email: 'sixth@sample.example', password: 'a long sample password', name: 'SAMPLE' });
  assert.equal(r.status, 403); assert.match((await r.json()).error, /needs an invite code/); ok('signup: open sign-up can be turned off');
} finally {
  closed.stop();
}

fake.close();
console.log('ALL FUNCTION CHECKS PASSED');
