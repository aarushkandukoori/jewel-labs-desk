// Jewel Labs sign-up (Supabase Edge Function, Deno). Deployed with --no-verify-jwt: callers are not signed in yet.
//
// POST { email, password, name, inviteCode?, houseName? } -> { ok: true, workspaceId } or { ok: false, error }
//   * with an invite code: creates the account and adds the person to that house with the invite's role
//   * without a code: creates the account and a new sandbox house where the person is the owner
//     (turn this off with the secret ALLOW_OPEN_SIGNUP=false)
// Accounts are created already confirmed, so nobody waits for a confirmation email. The app signs in right after.
// Each network may try 10 times an hour, and all networks together SIGNUP_HOURLY_CAP times an hour (default 100).
// When the counter cannot be read, nobody signs up (it fails closed). Passwords are never logged.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const TRIES_PER_HOUR = 10; // per network
const DEFAULT_HOURLY_CAP = 100; // all networks together: a ceiling that holds even if an address is faked

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

type Form = { email: string; password: string; name: string; inviteCode: string; houseName: string };

function reply(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

function refuse(status: number, error: string): Response {
  return reply(status, { ok: false, error });
}

// Checks and tidies the form. Returns the form, or a message for the person.
// deno-lint-ignore no-explicit-any
function readForm(input: any): Form | string {
  if (!input || typeof input !== 'object') return 'Send email, password and name.';
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const inviteCode = typeof input.inviteCode === 'string' ? input.inviteCode.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  const houseName = typeof input.houseName === 'string' ? input.houseName.trim() : '';
  if (!EMAIL.test(email) || email.length > 254) return 'Enter a valid email address.';
  if (password.length < 8) return 'Use a password of at least 8 characters.';
  if (password.length > 72) return 'Use a password of at most 72 characters.';
  if (!name || name.length > 100) return 'Enter your name (up to 100 characters).';
  if (inviteCode && !INVITE_CODE.test(inviteCode)) return 'Invite codes are 8 letters and numbers. Check the code and try again.';
  if (houseName.length > 120) return 'Keep the house name under 120 characters.';
  return { email, password, name, inviteCode, houseName };
}

function hourlyCap(): number {
  const cap = Number.parseInt(Deno.env.get('SIGNUP_HOURLY_CAP') || '', 10);
  return Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_HOURLY_CAP;
}

// The caller's network address. Cloudflare, in front of Supabase, sets cf-connecting-ip to the address it saw and
// replaces any value the caller sent. The first X-Forwarded-For entry is only a fallback: the caller can write it.
let addressSourceLogged = false;
function clientAddress(req: Request): string {
  const direct = (req.headers.get('cf-connecting-ip') || '').trim();
  if (!addressSourceLogged) {
    addressSourceLogged = true; // once per instance, so the logs show which header the platform provides
    console.log(`signup: network address from ${direct ? 'cf-connecting-ip' : 'x-forwarded-for (cf-connecting-ip missing)'}`);
  }
  return direct || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

// Rate limit by network and overall. Only a SHA-256 of the IP address is stored.
async function allowedToTry(req: Request): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`jl-signup:${clientAddress(req)}`));
  const ipHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const { data, error } = await admin.rpc('note_signup_attempt', {
    p_ip_hash: ipHash,
    p_limit: TRIES_PER_HOUR,
    p_global_limit: hourlyCap(),
  });
  if (error) throw new Error(`note_signup_attempt failed: ${error.message}`); // no counter, no sign-up
  return Boolean(data);
}

// A first look, so no account is made for a code that cannot work. redeem_invite checks again, under a lock.
async function inviteIsValid(code: string, email: string): Promise<boolean> {
  const { data, error } = await admin
    .from('invites')
    .select('role, email, expires_at, uses, max_uses')
    .eq('code', code)
    .maybeSingle();
  if (error) throw new Error(`invite lookup failed: ${error.message}`);
  if (!data || new Date(data.expires_at) <= new Date() || data.uses >= data.max_uses) return false;
  if (data.role === 'desk' && !data.email) return false; // desk invites name one person
  return !data.email || data.email === email; // an invite for a named person works only for that email
}

// Creates a confirmed account. Returns its id, or a Response explaining why not.
async function createAccount(form: Form): Promise<{ userId: string } | Response> {
  const { data, error } = await admin.auth.admin.createUser({
    email: form.email,
    password: form.password,
    email_confirm: true,
    user_metadata: { name: form.name },
  });
  if (error || !data?.user) {
    const message = error?.message || '';
    if (error?.code === 'email_exists' || error?.code === 'user_already_exists' || /already (been )?registered|already exists/i.test(message)) {
      return refuse(409, 'An account with this email already exists. Sign in instead; you can enter an invite code after signing in.');
    }
    if (error?.code === 'weak_password') return refuse(400, message || 'Choose a stronger password.');
    throw new Error(`createUser failed: ${message}`);
  }
  // The database trigger makes the profile; this covers a project where the trigger is missing.
  await admin
    .from('profiles')
    .upsert({ user_id: data.user.id, email: form.email, name: form.name }, { onConflict: 'user_id', ignoreDuplicates: true });
  return { userId: data.user.id };
}

async function removeAccount(userId: string): Promise<void> {
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) console.error('could not remove a half-created account:', error.message);
}

async function signUpWithCode(form: Form): Promise<Response> {
  if (!(await inviteIsValid(form.inviteCode, form.email))) return refuse(400, 'That invite code is not valid or has expired.');
  const account = await createAccount(form);
  if (account instanceof Response) return account;
  // redeem_invite locks the invite row, so two people cannot use its last place at once.
  const { data: workspaceId, error } = await admin.rpc('redeem_invite', { p_code: form.inviteCode, p_user: account.userId });
  if (error || !workspaceId) {
    await removeAccount(account.userId);
    if (error) throw new Error(`redeem_invite failed: ${error.message}`);
    return refuse(400, 'That invite code is not valid or has expired.');
  }
  return reply(200, { ok: true, workspaceId });
}

async function signUpWithNewHouse(form: Form): Promise<Response> {
  if (Deno.env.get('ALLOW_OPEN_SIGNUP') === 'false') {
    return refuse(403, 'Sign-up needs an invite code from your house or from Jewel Labs.');
  }
  const account = await createAccount(form);
  if (account instanceof Response) return account;
  const houseName = form.houseName || `${form.name}'s house`;
  const { data: house, error } = await admin.rpc('create_house_for', {
    p_user: account.userId,
    p_payload: { name: houseName.slice(0, 120) },
  });
  if (error || !house?.id) {
    await removeAccount(account.userId);
    throw new Error(`create_house_for failed: ${error?.message || 'no house returned'}`);
  }
  return reply(200, { ok: true, workspaceId: house.id });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return refuse(405, 'Use POST.');
  try {
    if (!(await allowedToTry(req))) return refuse(429, 'Too many sign-ups right now. Try again in an hour.');
    let input: unknown;
    try {
      input = await req.json();
    } catch {
      return refuse(400, 'The request is not valid JSON.');
    }
    const form = readForm(input);
    if (typeof form === 'string') return refuse(400, form);
    return form.inviteCode ? await signUpWithCode(form) : await signUpWithNewHouse(form);
  } catch (err) {
    // Log the reason only. Never the request body: it holds the password.
    console.error('signup failed:', err instanceof Error ? err.message : String(err));
    return refuse(500, 'Sign-up failed on the server. Try again in a minute.');
  }
});
