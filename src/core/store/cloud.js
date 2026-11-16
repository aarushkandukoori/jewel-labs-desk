// Cloud access through Supabase: sign-in, houses (workspaces), invite codes and the worker lease.
// The records themselves are synced by cloud-store.js (re-exported here). The small pure helpers that turn
// database rows into app objects live in rows.js.
//
// The Supabase URL and publishable (anon) key are public. Row-level security in the database decides what each
// signed-in person may read or change (see backend/supabase/migrations/0001_init.sql).
import { createClient } from '@supabase/supabase-js';
import { NETWORK_MESSAGE, friendlyMessage, housePayload, toCloudError, workspaceFromRow } from './rows.js';

export { openCloudStore } from './cloud-store.js';
export * from './rows.js';

/**
 * createCloud({ url, anonKey, sessionStorage }) ->
 *   { auth, workspaces, lease, aiProxyUrl, accessToken(), client, url, close() }
 * sessionStorage keeps the sign-in between app starts: { getItem(key), setItem(key, value), removeItem(key) },
 * sync or async. The Electron main process passes one that encrypts with safeStorage. Without it the sign-in
 * lasts until the app quits.
 */
export function createCloud({ url, anonKey, sessionStorage, fetch } = {}) {
  if (!url || !anonKey) {
    throw new Error('Cloud sign-in is not set up. Set JL_SUPABASE_URL and JL_SUPABASE_ANON_KEY (see backend/supabase/README.md).');
  }
  const options = {
    auth: {
      storage: sessionStorage || memoryStorage(),
      storageKey: 'jl-auth',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  };
  if (fetch) options.global = { fetch };
  const client = createClient(url, anonKey, options);
  const baseUrl = url.replace(/\/+$/, '');
  let profileCache = null; // { userId, profile } for the signed-in person

  async function rpc(name, args) {
    const { data, error, status } = await client.rpc(name, args);
    if (error) throw userError(toCloudError(error, status));
    return data;
  }

  async function loadProfile(userId) {
    if (profileCache?.userId === userId) return profileCache.profile;
    // retry(false): fail at once when offline instead of supabase-js retrying reads for about 7 s.
    const { data, error } = await client
      .from('profiles')
      .select('name, is_desk, is_test')
      .eq('user_id', userId)
      .maybeSingle()
      .retry(false);
    if (error) return null; // a missing profile must not block sign-in; try again next time
    profileCache = { userId, profile: data };
    return data;
  }

  async function currentSession() {
    const { data } = await client.auth.getSession();
    return data?.session || null;
  }

  const auth = {
    async signIn({ email, password } = {}) {
      const { data, error } = await client.auth.signInWithPassword({ email: String(email || '').trim(), password });
      if (error) throw authError(error);
      profileCache = null;
      return sessionSummary(data.session, await loadProfile(data.session.user.id));
    },

    /** Creates the account through the "signup" Edge Function (no confirmation email), then signs in. */
    async signUp({ email, password, name, inviteCode, houseName } = {}) {
      const { data, error } = await client.functions.invoke('signup', {
        body: { email, password, name, inviteCode: inviteCode || undefined, houseName: houseName || undefined },
      });
      if (error) throw await functionError(error);
      if (!data?.ok) throw new Error(data?.error || 'Sign-up failed. Try again.');
      const session = await auth.signIn({ email, password });
      return { ...session, workspaceId: data.workspaceId || null };
    },

    async signOut() {
      // "local" signs out this computer only, not the person's other devices.
      const { error } = await client.auth.signOut({ scope: 'local' });
      profileCache = null;
      if (error && error.status !== 401) throw authError(error);
    },

    /** The current sign-in, or null: { user: { id, email, name }, isDesk, isTest, expiresAt }. */
    async session() {
      const session = await currentSession();
      if (!session) return null;
      return sessionSummary(session, await loadProfile(session.user.id));
    },

    /** Calls fn({ event, signedIn, userId }) when the sign-in changes. Returns a function that stops it. */
    onChange(fn) {
      const { data } = client.auth.onAuthStateChange((event, session) => {
        if (profileCache && profileCache.userId !== session?.user?.id) profileCache = null;
        // Run the listener after Supabase finishes its own work; calling Supabase inside this callback can stall.
        setTimeout(() => fn({ event, signedIn: Boolean(session), userId: session?.user?.id || null }), 0);
      });
      return () => data.subscription.unsubscribe();
    },
  };

  const workspaces = {
    /** Every house the person can open (desk users see all houses), each with myRole. */
    async list() {
      const rows = (await rpc('list_my_workspaces')) || [];
      return rows.map((row) => ({ ...workspaceFromRow(row), myRole: row.my_role }));
    },

    /** Creates a sandbox house; the creator becomes its owner. */
    async create(profile = {}) {
      const row = await rpc('create_house', { p_payload: housePayload(profile) });
      return { ...workspaceFromRow(row), myRole: 'owner' };
    },

    async join(code) {
      const row = await rpc('join_with_code', { p_code: String(code || '') });
      if (!row?.id) throw new Error('That invite code is not valid or has expired.');
      return workspaceFromRow(row);
    },

    /** A new invite code for the house (owner or desk only). Codes last 14 days. */
    async invite(workspaceId, role = 'preparer') {
      const code = await rpc('create_invite', { p_workspace: workspaceId, p_role: role });
      return { code };
    },

    async members(workspaceId) {
      const { data, error, status } = await client
        .from('members')
        .select('user_id, email, name, role, created_at')
        .eq('workspace_id', workspaceId)
        .order('created_at')
        .retry(false);
      if (error) throw userError(toCloudError(error, status));
      return data.map((m) => ({ userId: m.user_id, email: m.email, name: m.name, role: m.role, createdAt: m.created_at }));
    },
  };

  // Only one computer per house runs the agents at a time. It holds the lease and renews it while it works.
  const lease = {
    async acquire(workspaceId, holder, ttlSeconds = 300) {
      return Boolean(await rpc('acquire_lease', { p_workspace: workspaceId, p_holder: holder, p_ttl_seconds: ttlSeconds }));
    },
    async release(workspaceId, holder) {
      await rpc('release_lease', { p_workspace: workspaceId, p_holder: holder });
    },
  };

  return {
    client,
    url: baseUrl,
    auth,
    workspaces,
    lease,
    aiProxyUrl: `${baseUrl}/functions/v1/ai`,
    /** The signed-in person's access token (refreshed when needed), or null. */
    async accessToken() {
      return (await currentSession())?.access_token || null;
    },
    /** Stops background token refresh and realtime connections (call when the app quits). */
    async close() {
      await client.auth.stopAutoRefresh();
      for (const channel of client.getChannels()) await client.removeChannel(channel);
      // Only disconnect a live socket: realtime-js leaves a 10 s timer running after every disconnect().
      if (client.realtime.isConnected()) await client.realtime.disconnect();
    },
  };
}

function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

function sessionSummary(session, profile) {
  const user = session.user;
  return {
    user: { id: user.id, email: user.email, name: profile?.name || user.user_metadata?.name || '' },
    isDesk: Boolean(profile?.is_desk),
    isTest: Boolean(profile?.is_test),
    expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
  };
}

function authError(error) {
  const message = String(error?.message || '');
  if (error?.code === 'invalid_credentials' || /invalid login credentials/i.test(message)) {
    return new Error('Wrong email or password.');
  }
  if (error?.code === 'email_not_confirmed') return new Error('This email is not confirmed yet.');
  if (error?.status === 429) return new Error('Too many tries. Wait a minute and try again.');
  if (error?.name === 'AuthRetryableFetchError' || !error?.status) return new Error(NETWORK_MESSAGE);
  return new Error(message || 'Sign-in failed.');
}

async function functionError(error) {
  // FunctionsHttpError carries the Response; our function answers { ok: false, error: '...' }.
  const response = error?.context;
  if (response && typeof response.json === 'function') {
    try {
      const body = await response.json();
      if (body?.error) return new Error(typeof body.error === 'string' ? body.error : body.error.message);
    } catch {
      // not JSON: fall through
    }
  }
  if (error?.name === 'FunctionsFetchError') return new Error(NETWORK_MESSAGE);
  return new Error(error?.message || 'Sign-up failed. Try again.');
}

function userError(err) {
  return Object.assign(new Error(friendlyMessage(err)), { code: err.code, status: err.status, retryable: err.retryable });
}
