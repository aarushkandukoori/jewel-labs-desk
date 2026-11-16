// Checks every file in migrations/ without a Supabase project. It applies them in order, twice, to PGlite (real
// Postgres compiled to WebAssembly) with small stand-ins for Supabase's auth and storage schemas and roles, then
// tries the security rules as different people: owner, preparer, viewer, outsider, desk user, service role.
//
// PGlite is not a dependency of the app. Install it in any folder and point PGLITE_DIR at that folder:
//   mkdir -p /tmp/pglite && npm install --prefix /tmp/pglite @electric-sql/pglite@0.5.14
//   PGLITE_DIR=/tmp/pglite node backend/supabase/tests/check-sql.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadPglite() {
  const base = process.env.PGLITE_DIR
    ? pathToFileURL(path.join(process.env.PGLITE_DIR, 'node_modules', '@electric-sql', 'pglite', 'dist') + path.sep).href
    : null;
  try {
    const main = await import(base ? `${base}index.js` : '@electric-sql/pglite');
    const contrib = await import(base ? `${base}contrib/pgcrypto.js` : '@electric-sql/pglite/contrib/pgcrypto');
    return { PGlite: main.PGlite, pgcrypto: contrib.pgcrypto };
  } catch {
    console.error('PGlite is not installed. See the top of this file for the two commands to run.');
    process.exit(2);
  }
}

const { PGlite, pgcrypto } = await loadPglite();
const migrationsDir = new URL('../migrations/', import.meta.url);
const migrationFiles = (await fs.readdir(migrationsDir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

const db = await PGlite.create({ extensions: { pgcrypto } });

const MOCK = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema auth;
create schema storage;
create schema extensions;
create table auth.users (
  id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb, email_confirmed_at timestamptz default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create unique index on storage.objects (bucket_id, name);
alter table storage.objects enable row level security;
grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
`;

await db.exec(MOCK);
// A house that exists before 0003 (which adds the AI approval) must keep the AI allowance it had.
const OLDER_HOUSE = '00000000-0000-4000-8000-0000000000a0';
for (const name of migrationFiles) {
  if (name.startsWith('0003_')) await db.query(`insert into public.workspaces (id, name) values ($1, 'SAMPLE Older House')`, [OLDER_HOUSE]);
  await db.exec(await fs.readFile(new URL(name, migrationsDir), 'utf8'));
}
for (const name of migrationFiles) await db.exec(await fs.readFile(new URL(name, migrationsDir), 'utf8')); // safe to run twice
console.log(`ok - ${migrationFiles.length} migrations (${migrationFiles.join(', ')}) applied in order, twice`);
const older = (await db.query(`select ai_approved from public.workspaces where id = $1`, [OLDER_HOUSE])).rows[0];
assert.equal(older.ai_approved, true, 'a house from before 0003 keeps its AI allowance');
console.log('ok - a house from before 0003 keeps its AI allowance');
await db.query(`delete from public.workspaces where id = $1`, [OLDER_HOUSE]);

const ids = {
  owner: '00000000-0000-4000-8000-00000000000a',
  preparer: '00000000-0000-4000-8000-00000000000b',
  viewer: '00000000-0000-4000-8000-00000000000c',
  outsider: '00000000-0000-4000-8000-00000000000d',
  desk: '00000000-0000-4000-8000-00000000000e',
};
for (const [name, id] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [
    id,
    `${name}@sample.example`,
    JSON.stringify({ name: `SAMPLE ${name}` }),
  ]);
}
const profiles = await db.query('select user_id, email, name, is_desk from public.profiles order by email');
assert.equal(profiles.rows.length, 5, 'the trigger made a profile per user');
assert.equal(profiles.rows.find((p) => p.email === 'owner@sample.example').name, 'SAMPLE owner');
await db.query(`update public.profiles set is_desk = true where user_id = $1`, [ids.desk]);

async function as(who, fn) {
  const sub = who === 'service' || who === 'anon' ? '' : ids[who];
  const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : 'authenticated';
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${sub}', false); set role ${role};`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}
const q = async (sql, params) => (await db.query(sql, params)).rows;
async function fails(promise, pattern, label) {
  try {
    await promise;
  } catch (err) {
    if (pattern && !pattern.test(err.message)) throw new Error(`${label}: wrong error: ${err.message}`);
    return err.message;
  }
  throw new Error(`${label}: expected an error`);
}
const check = (label, ok) => {
  assert.ok(ok, label);
  console.log(`ok - ${label}`);
};

// ---------- houses, invites, joining ----------
const house = (await as('owner', () => q(`select * from create_house($1::jsonb)`, [JSON.stringify({ name: 'SAMPLE Exports', city: 'Surat', id: 'x', myRole: 'owner' })])))[0];
check('create_house returns the house in sandbox', house.id && house.environment === 'sandbox' && house.name === 'SAMPLE Exports');
check('create_house keeps settings in data, without id/name/myRole', house.data.city === 'Surat' && !('id' in house.data) && !('name' in house.data) && !('myRole' in house.data));
const W = house.id;
check('owner is a member with role owner', (await q(`select role from members where workspace_id = $1 and user_id = $2`, [W, ids.owner]))[0].role === 'owner');

const prepCode = (await as('owner', () => q(`select create_invite($1, 'preparer') as code`, [W])))[0].code;
const viewCode = (await as('owner', () => q(`select create_invite($1, 'viewer') as code`, [W])))[0].code;
check('invite codes are 8 chars without look-alikes', /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(prepCode) && prepCode !== viewCode);
await fails(as('preparer', () => q(`select create_invite($1, 'viewer')`, [W])), /Only the house owner or Jewel Labs/, 'non-member invite');
await fails(as('owner', () => q(`select create_invite($1, 'desk')`, [W])), /Only Jewel Labs can invite desk/, 'owner desk invite');
await fails(as('owner', () => q(`select create_invite($1, 'boss')`, [W])), /Unknown role/, 'bad role');
await fails(as('owner', () => q(`select create_invite($1, null)`, [W])), /Unknown role/, 'null role');

const joined = (await as('preparer', () => q(`select * from join_with_code($1)`, [prepCode.toLowerCase().slice(0, 4) + '-' + prepCode.slice(4)])))[0];
check('join_with_code accepts lower case and a dash', joined.id === W);
await as('viewer', () => q(`select * from join_with_code($1)`, [viewCode]));
const again = (await as('preparer', () => q(`select * from join_with_code($1)`, [viewCode])))[0];
check('joining again keeps the existing role', again.id === W && (await q(`select role from members where workspace_id = $1 and user_id = $2`, [W, ids.preparer]))[0].role === 'preparer');
check('invite uses counted once per new member', (await q(`select uses from invites where code = $1`, [viewCode]))[0].uses === 1);
const wrong = (await as('outsider', () => q(`select * from join_with_code('ZZZZZZZZ')`)))[0];
check('a wrong code returns an empty house (no id)', wrong.id === null);
for (let i = 0; i < 9; i += 1) await as('outsider', () => q(`select * from join_with_code('ZZZZZZZZ')`));
await fails(as('outsider', () => q(`select * from join_with_code('ZZZZZZZZ')`)), /Too many wrong codes/, 'guessing limit');
await fails(as('anon', () => q(`select * from join_with_code($1)`, [prepCode])), /permission denied/, 'anon cannot join');

const mine = await as('preparer', () => q(`select id, my_role from list_my_workspaces()`));
check('list_my_workspaces shows the house with my role', mine.length === 1 && mine[0].my_role === 'preparer');
const deskList = await as('desk', () => q(`select id, my_role from list_my_workspaces()`));
check('desk users see every house as desk', deskList.length === 1 && deskList[0].my_role === 'desk');
check('outsiders see no house', (await as('outsider', () => q(`select id from list_my_workspaces()`))).length === 0);

// ---------- records ----------
await as('preparer', () => q(`insert into records (workspace_id, collection, id, data) values ($1, 'documents', 'd1', '{"a":1}')`, [W]));
let row = (await q(`select rev, updated_by from records where id = 'd1'`))[0];
check('insert sets rev 1 and updated_by', row.rev === 1 && row.updated_by === ids.preparer);
const upserted = await as('preparer', () =>
  q(`insert into records (workspace_id, collection, id, data) values ($1, 'documents', 'd1', '{"a":2}')
     on conflict (workspace_id, collection, id) do update set data = excluded.data returning collection, id, rev, updated_at`, [W]),
);
check('upsert bumps rev and returns it', upserted[0].rev === 2);
await as('owner', () => q(`update records set rev = 99, updated_by = $2 where workspace_id = $1 and id = 'd1'`, [W, ids.viewer]));
row = (await q(`select rev, updated_by from records where id = 'd1'`))[0];
check('the app cannot set rev or updated_by itself', row.rev === 3 && row.updated_by === ids.owner);
check('viewer reads records', (await as('viewer', () => q(`select id from records where workspace_id = $1`, [W]))).length === 1);
await fails(as('viewer', () => q(`insert into records (workspace_id, collection, id, data) values ($1, 'documents', 'v1', '{}')`, [W])), /row-level security/, 'viewer insert');
check('viewer update changes nothing', (await as('viewer', () => q(`update records set data = '{}' where workspace_id = $1 returning id`, [W]))).length === 0);
check('outsider reads nothing', (await as('outsider', () => q(`select id from records`))).length === 0);
await fails(as('outsider', () => q(`insert into records (workspace_id, collection, id, data) values ($1, 'documents', 'o1', '{}')`, [W])), /row-level security/, 'outsider insert');
await as('desk', () => q(`insert into records (workspace_id, collection, id, data) values ($1, 'papers', 'p1', '{"status":"held_for_review"}')`, [W]));
check('desk users write any house', (await q(`select id from records where id = 'p1'`)).length === 1);
await fails(as('preparer', () => q(`insert into records (workspace_id, collection, id, data) values ($1, 'Workspace', 'x', '{}')`, [W])), /check constraint/, 'bad collection name');
await fails(as('anon', () => q(`select * from records`)), /permission denied/, 'anon reads records');

for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) {
  await as('preparer', () => q(`insert into records (workspace_id, collection, id, data) values ($1, 'activity', $2, '{}')`, [W, id]));
}
let after = { c: '', i: '' };
const paged = [];
for (;;) {
  const page = await as('viewer', () => q(`select collection, id from list_records($1, $2, $3, 2)`, [W, after.c, after.i]));
  paged.push(...page.map((r) => `${r.collection}/${r.id}`));
  if (page.length < 2) break;
  after = { c: page.at(-1).collection, i: page.at(-1).id };
}
check('list_records pages through every row once, in key order', JSON.stringify(paged) === JSON.stringify(['activity/a1', 'activity/a2', 'activity/a3', 'activity/a4', 'activity/a5', 'documents/d1', 'papers/p1']));
check('list_records respects RLS', (await as('outsider', () => q(`select id from list_records($1)`, [W]))).length === 0);

// ---------- house settings ----------
const upd = (await as('preparer', () => q(`select * from update_house($1, $2::jsonb)`, [W, JSON.stringify({ autopilot: false, permissions: { ofacScreen: false } })])))[0];
check('preparer changes settings; only sent keys change; rev bumps', upd.data.autopilot === false && upd.data.city === 'Surat' && upd.rev === 2);
await fails(as('preparer', () => q(`select * from update_house($1, '{"environment":"live"}'::jsonb)`, [W])), /Only the house owner or Jewel Labs/, 'preparer goes live');
const live = (await as('owner', () => q(`select * from update_house($1, '{"environment":"live","name":"SAMPLE Exports Ltd"}'::jsonb)`, [W])))[0];
check('owner switches to live and renames', live.environment === 'live' && live.name === 'SAMPLE Exports Ltd');
await fails(as('viewer', () => q(`select * from update_house($1, '{"autopilot":true}'::jsonb)`, [W])), /cannot change the settings/, 'viewer settings');
await fails(as('outsider', () => q(`select * from update_house($1, '{"autopilot":true}'::jsonb)`, [W])), /cannot change the settings/, 'outsider settings');
await fails(as('owner', () => q(`update workspaces set created_by = $2 where id = $1`, [W, ids.outsider])), /permission denied/, 'change created_by');

// ---------- profiles ----------
await fails(as('preparer', () => q(`update profiles set is_desk = true where user_id = $1`, [ids.preparer])), /permission denied/, 'make myself desk');
await as('preparer', () => q(`update profiles set name = 'SAMPLE renamed' where user_id = $1`, [ids.preparer]));
check('people may rename themselves', (await q(`select name from profiles where user_id = $1`, [ids.preparer]))[0].name === 'SAMPLE renamed');
check('people cannot rename others', (await as('preparer', () => q(`update profiles set name = 'x' where user_id = $1 returning user_id`, [ids.owner]))).length === 0);
check('people see only their own profile', (await as('preparer', () => q(`select user_id from profiles`))).length === 1);
check('desk sees all profiles', (await as('desk', () => q(`select user_id from profiles`))).length === 5);

// ---------- members and invites tables ----------
check('members see their housemates', (await as('viewer', () => q(`select user_id from members where workspace_id = $1`, [W]))).length === 3);
check('invites visible to the owner only', (await as('owner', () => q(`select code from invites`))).length === 2 && (await as('preparer', () => q(`select code from invites`))).length === 0);
check('a preparer cannot remove the owner', (await as('preparer', () => q(`delete from members where user_id = $1 returning user_id`, [ids.owner]))).length === 0);
await fails(as('outsider', () => q(`insert into members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [W, ids.outsider])), /permission denied/, 'self-add member');

// ---------- leases ----------
const lease = async (who, holder) => (await as(who, () => q(`select acquire_lease($1, $2, 60) as ok`, [W, holder])))[0].ok;
check('first computer gets the lease', (await lease('preparer', 'mac-1')) === true);
check('another computer does not', (await lease('owner', 'win-2')) === false);
check('the holder renews it', (await lease('preparer', 'mac-1')) === true);
check('a viewer never gets it', (await lease('viewer', 'view-3')) === false);
await as('preparer', () => q(`select release_lease($1, 'mac-1')`, [W]));
check('after release another computer gets it', (await lease('owner', 'win-2')) === true);
await q(`update worker_leases set expires_at = now() - interval '1 second' where workspace_id = $1`, [W]);
check('an expired lease can be taken over', (await lease('preparer', 'mac-1')) === true);

// ---------- AI usage (service role only) ----------
const reserve = async () => (await as('service', () => q(`select reserve_ai_call($1, 2) as ok`, [W])))[0].ok;
check('reserve_ai_call allows up to the cap', (await reserve()) === true && (await reserve()) === true && (await reserve()) === false);
await as('service', () => q(`select bump_ai_usage($1, 1200, 300)`, [W]));
const usage = (await q(`select calls, input_tokens, output_tokens from ai_usage where workspace_id = $1`, [W]))[0];
check('usage counts calls and tokens', usage.calls === 2 && Number(usage.input_tokens) === 1200 && Number(usage.output_tokens) === 300);
await fails(as('owner', () => q(`select reserve_ai_call($1, 1000)`, [W])), /permission denied/, 'app reserves AI calls');
await fails(as('owner', () => q(`select bump_ai_usage($1, 1, 1)`, [W])), /permission denied/, 'app bumps usage');
check('members can read usage', (await as('viewer', () => q(`select calls from ai_usage`))).length === 1);

// ---------- service-role functions used by the signup function ----------
const svcUser = '00000000-0000-4000-8000-0000000000ff';
await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'new@sample.example', '{"name":"SAMPLE new"}')`, [svcUser]);
const svcHouse = (await as('service', () => q(`select * from create_house_for($1, '{"name":"SAMPLE New House"}'::jsonb)`, [svcUser])))[0];
check('create_house_for makes a sandbox house owned by the new person', svcHouse.environment === 'sandbox' && (await q(`select role from members where workspace_id = $1 and user_id = $2`, [svcHouse.id, svcUser]))[0].role === 'owner');
const redeemed = (await as('service', () => q(`select redeem_invite($1, $2) as ws`, [prepCode, svcUser])))[0].ws;
check('redeem_invite adds the person to the invited house', redeemed === W);
check('redeem_invite returns null for a bad code', (await as('service', () => q(`select redeem_invite('AAAAAAAA', $1) as ws`, [svcUser])))[0].ws === null);
await fails(as('owner', () => q(`select redeem_invite($1, $2)`, [prepCode, ids.outsider])), /permission denied/, 'app redeems directly');
await fails(as('owner', () => q(`select * from create_house_for($1, '{"name":"x"}'::jsonb)`, [ids.outsider])), /permission denied/, 'app calls create_house_for');
const tries = [];
for (let i = 0; i < 11; i += 1) tries.push((await as('service', () => q(`select note_signup_attempt('hash-1', 10) as ok`)))[0].ok);
check('note_signup_attempt allows 10 per hour', tries.slice(0, 10).every(Boolean) && tries[10] === false);
await fails(as('anon', () => q(`select note_signup_attempt('hash-2', 10)`)), /permission denied/, 'anon notes attempts');

// ---------- house limit ----------
for (let i = 0; i < 5; i += 1) await as('outsider', () => q(`select id from create_house($1::jsonb)`, [JSON.stringify({ name: `SAMPLE ${i}` })]));
await fails(as('outsider', () => q(`select id from create_house('{"name":"SAMPLE 6"}'::jsonb)`)), /up to 5 houses/, 'house limit');
await fails(as('outsider', () => q(`select id from create_house('{"name":"  "}'::jsonb)`)), /house name is required/, 'empty name');
const deskLive = (await as('desk', () => q(`select environment from create_house('{"name":"SAMPLE Live","environment":"live"}'::jsonb)`)))[0];
check('only desk users create a live house directly', deskLive.environment === 'live');
const ownerLive = (await as('owner', () => q(`select environment from create_house('{"name":"SAMPLE Try Live","environment":"live"}'::jsonb)`)))[0];
check('others always start in sandbox', ownerLive.environment === 'sandbox');

// ---------- storage ----------
check('workspace_from_path reads the first folder', (await q(`select workspace_from_path($1) as ws`, [`${W}/docs/d1/x.pdf`]))[0].ws === W);
check('workspace_from_path is null for junk', (await q(`select workspace_from_path('not-a-uuid/x') as ws`))[0].ws === null);
await as('preparer', () => q(`insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${W}/docs/d1/SAMPLE invoice.pdf`]));
check('members see the house files', (await as('viewer', () => q(`select name from storage.objects`))).length === 1);
check('outsiders do not', (await as('outsider', () => q(`select name from storage.objects`))).length === 0);
await fails(as('viewer', () => q(`insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${W}/docs/v/x.pdf`])), /row-level security/, 'viewer upload');
await fails(as('outsider', () => q(`insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${W}/docs/o/x.pdf`])), /row-level security/, 'outsider upload');
await fails(as('preparer', () => q(`insert into storage.objects (bucket_id, name) values ('documents', 'junk/x.pdf')`)), /row-level security/, 'upload outside a house folder');
check('desk sees every file', (await as('desk', () => q(`select name from storage.objects`))).length === 1);
check('the bucket is private with a 50 MB limit', (await q(`select public, file_size_limit from storage.buckets where id = 'documents'`))[0].public === false);

// ---------- realtime publication ----------
const published = (await q(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename`)).map((r) => r.tablename);
check('records and workspaces are published for Realtime', JSON.stringify(published) === JSON.stringify(['records', 'workspaces']));

// ---------- leaving ----------
check('a member can leave', (await as('viewer', () => q(`delete from members where user_id = $1 returning user_id`, [ids.viewer]))).length === 1);
check('after leaving they see nothing', (await as('viewer', () => q(`select id from records`))).length === 0);

// ---------- 0003: AI limits per house and per person, trial houses ----------
const LIMITS = { house_calls: 100, trial_calls: 100, user_calls: 100, house_tokens: 1e9, trial_tokens: 1e9, user_tokens: 1e9 };
const reserveFor = async (ws, user, over = {}) => {
  const l = { ...LIMITS, ...over };
  const sql = `select reserve_ai_call($1, $2, $3, $4, $5, $6, $7, $8) as v`;
  return (await as('service', () => q(sql, [ws, user, l.house_calls, l.trial_calls, l.user_calls, l.house_tokens, l.trial_tokens, l.user_tokens])))[0].v;
};
const approvedFlag = async (ws) => (await q(`select ai_approved from workspaces where id = $1`, [ws]))[0].ai_approved;
check('a house made in the app starts in trial; one made by Jewel Labs is approved', (await approvedFlag(W)) === false && (await q(`select bool_and(ai_approved) as ok from workspaces where created_by = $1`, [ids.desk]))[0].ok === true);
const trialHouse = (await as('preparer', () => q(`select id from create_house('{"name":"SAMPLE Trial House"}'::jsonb)`)))[0].id;
const trial = [await reserveFor(trialHouse, ids.preparer, { trial_calls: 2 }), await reserveFor(trialHouse, ids.preparer, { trial_calls: 2 }), await reserveFor(trialHouse, ids.preparer, { trial_calls: 2 })];
check('a trial house gets the trial allowance', JSON.stringify(trial) === JSON.stringify(['ok', 'ok', 'trial_calls']));
await fails(as('preparer', () => q(`select approve_house_ai($1)`, [trialHouse])), /Only Jewel Labs can approve/, 'owner approves own house');
await fails(as('preparer', () => q(`update workspaces set ai_approved = true where id = $1`, [trialHouse])), /permission denied/, 'owner sets ai_approved');
await as('preparer', () => q(`select * from update_house($1, '{"ai_approved":true}'::jsonb)`, [trialHouse]));
check('update_house cannot approve a house (the key lands in the settings)', (await approvedFlag(trialHouse)) === false);
check('Jewel Labs approves a house', (await as('desk', () => q(`select approve_house_ai($1) as ok`, [trialHouse])))[0].ok === true && (await approvedFlag(trialHouse)) === true);
check('an approved house gets the full allowance', (await reserveFor(trialHouse, ids.preparer, { trial_calls: 2, house_calls: 4 })) === 'ok' && (await reserveFor(trialHouse, ids.preparer, { trial_calls: 2, house_calls: 4 })) === 'ok' && (await reserveFor(trialHouse, ids.preparer, { house_calls: 4 })) === 'house_calls');
// The preparer has made 4 counted calls today, all on trialHouse. The person limit counts every house together.
check('one person is limited across all their houses', (await reserveFor(W, ids.preparer, { user_calls: 5 })) === 'ok' && (await reserveFor(W, ids.preparer, { user_calls: 5 })) === 'user_calls');
check('desk staff are not limited per person', (await reserveFor(W, ids.desk, { user_calls: 0 })) === 'ok');
const personUsage = (await q(`select calls from ai_user_usage where user_id = $1`, [ids.preparer]))[0];
check('calls are counted per person', personUsage.calls === 5);
await as('service', () => q(`select bump_ai_usage($1, $2, 600, 400)`, [trialHouse, ids.preparer]));
check('a house over its daily tokens is refused', (await reserveFor(trialHouse, ids.desk, { house_tokens: 1000 })) === 'house_tokens');
check('a person over their daily tokens is refused', (await reserveFor(W, ids.preparer, { user_tokens: 1000 })) === 'user_tokens');
const tokenHouse = (await as('owner', () => q(`select id from create_house('{"name":"SAMPLE Token House"}'::jsonb)`)))[0].id;
await as('service', () => q(`select bump_ai_usage($1, $2, 40, 10)`, [tokenHouse, ids.owner]));
check('a trial house over its trial tokens is refused', (await reserveFor(tokenHouse, ids.owner, { trial_tokens: 50 })) === 'trial_tokens');
check('a missing limit refuses (nothing slips through)', (await as('service', () => q(`select reserve_ai_call($1, $2, null, null, null, null, null, null) as v`, [tokenHouse, ids.owner])))[0].v === 'trial_calls');
check('an unknown house is named as such', (await reserveFor('00000000-0000-4000-8000-0000000000ee', ids.owner)) === 'no_house');
await fails(as('owner', () => q(`select reserve_ai_call($1, $2, 1, 1, 1, 1, 1, 1)`, [W, ids.owner])), /permission denied/, 'app reserves AI calls (new)');
await fails(as('owner', () => q(`select bump_ai_usage($1, $2, 1, 1)`, [W, ids.owner])), /permission denied/, 'app bumps usage (new)');
await fails(as('owner', () => q(`select calls from ai_user_usage`)), /permission denied/, 'app reads usage per person');

// ---------- 0004: what only the desk or a signature decides ----------
// Saves the way the app does (PostgREST upsert): the insert step runs first, then the update step on a conflict.
const save = (who, collection, id, data) => as(who, () => q(
  `insert into records (workspace_id, collection, id, data) values ($1, $2, $3, $4::jsonb)
   on conflict (workspace_id, collection, id) do update set data = excluded.data returning data`,
  [W, collection, id, JSON.stringify({ id, ...data })],
));
const stored = async (collection, id) => (await q(`select data from records where workspace_id = $1 and collection = $2 and id = $3`, [W, collection, id]))[0]?.data;
const removeRecord = (who, collection, id) => as(who, () => q(`delete from records where workspace_id = $1 and collection = $2 and id = $3 returning id`, [W, collection, id]));

// A pack held for review (a check failed), built by the agents on the house's computer.
const fileV1 = 'papers/pap1/JL-EXP-1116-01-v1.pdf';
const heldV1 = {
  shipmentId: 'shp1', kind: 'export_pack', ref: 'JL-EXP-1116-01', version: 1, status: 'held_for_review', fileKey: fileV1, sha256: 'aa11',
  pages: 3, contents: [{ title: 'Invoice' }], signedBy: null, signedAt: null, sentTo: null, deskNote: null, approvedBy: null, approvedAt: null,
  versions: [{ version: 1, fileKey: fileV1, sha256: 'aa11', status: 'held_for_review' }],
};
await save('preparer', 'papers', 'pap1', heldV1);
await fails(save('preparer', 'papers', 'pap1', { ...heldV1, status: 'ready_to_sign' }), /held for review/, 'preparer releases a held paper');
await fails(save('preparer', 'papers', 'pap1', { ...heldV1, status: 'signed', signedBy: 'SAMPLE Clerk' }), /held for review/, 'preparer signs a held paper');
await fails(as('preparer', () => q(`update records set data = data || '{"status":"ready_to_sign"}' where workspace_id = $1 and id = 'pap1'`, [W])), /held for review/, 'preparer releases with a plain update');
await save('preparer', 'papers', 'pap1', { ...heldV1, approvedBy: 'Jewel Labs desk', approvedAt: '2026-11-16T09:00:00Z', deskNote: 'Fine' });
check('a preparer cannot write the desk approval', (await stored('papers', 'pap1')).approvedBy === null && (await stored('papers', 'pap1')).status === 'held_for_review');
const approvedV1 = { ...heldV1, status: 'ready_to_sign', deskNote: 'Checked.', approvedBy: 'SAMPLE desk', approvedAt: '2026-11-16T10:00:00Z' };
await save('desk', 'papers', 'pap1', approvedV1);
check('Jewel Labs releases a held paper', (await stored('papers', 'pap1')).status === 'ready_to_sign');
const signedV1 = {
  ...approvedV1, status: 'signed', unsignedFileKey: fileV1, fileKey: 'papers/pap1/JL-EXP-1116-01-v1-signed.pdf', sha256: 'bb22',
  signedBy: 'SAMPLE Clerk', signerTitle: 'Director', signedAt: '2026-11-16T11:00:00Z',
};
await save('preparer', 'papers', 'pap1', signedV1);
check('the house signs a paper that is ready; the approval stays', (await stored('papers', 'pap1')).status === 'signed' && (await stored('papers', 'pap1')).approvedBy === 'SAMPLE desk');
await fails(save('preparer', 'papers', 'pap1', { ...signedV1, sha256: 'forged' }), /signed paper cannot be changed/, 'rewrite a signed hash');
await fails(save('preparer', 'papers', 'pap1', { ...signedV1, fileKey: 'papers/pap1/other.pdf' }), /signed paper cannot be changed/, 'swap a signed file');
await fails(save('preparer', 'papers', 'pap1', { ...signedV1, status: 'ready_to_sign' }), /signed paper cannot be changed/, 'unsign in place');
await fails(removeRecord('preparer', 'papers', 'pap1'), /signed paper cannot be removed/, 'remove a signed paper');
const sentV1 = { ...signedV1, status: 'sent', sentTo: 'broker@sample.example', sentCc: null, sentAt: '2026-11-16T12:00:00Z', messageId: '<m1@sample>' };
await save('preparer', 'papers', 'pap1', sentV1);
const resent = { ...sentV1, sentTo: 'broker2@sample.example', sentAt: '2026-11-16T13:00:00Z', messageId: '<m2@sample>' };
await save('preparer', 'papers', 'pap1', resent);
check('a signed paper is sent, and sent again', (await stored('papers', 'pap1')).status === 'sent' && (await stored('papers', 'pap1')).sentTo === 'broker2@sample.example');
await fails(save('preparer', 'papers', 'pap1', { ...resent, status: 'signed' }), /signed paper cannot be changed/, 'unsend');
// A person rebuilds the sent pack (paperwork.js savePaper): the old version moves into the history as it ended.
const v1Entry = { ...heldV1.versions[0], status: 'sent', fileKey: signedV1.fileKey, sha256: 'bb22', signedBy: 'SAMPLE Clerk', signedAt: signedV1.signedAt, sentTo: resent.sentTo, sentAt: resent.sentAt };
const readyV2 = {
  ...resent, version: 2, status: 'ready_to_sign', fileKey: 'papers/pap1/JL-EXP-1116-01-v2.pdf', sha256: 'cc33', signedBy: null, signerTitle: null,
  signedAt: null, unsignedFileKey: null, sentTo: null, sentCc: null, sentAt: null, deskNote: null, approvedBy: null, approvedAt: null,
  versions: [v1Entry, { version: 2, fileKey: 'papers/pap1/JL-EXP-1116-01-v2.pdf', sha256: 'cc33', status: 'ready_to_sign' }],
};
await save('preparer', 'papers', 'pap1', { ...readyV2, approvedBy: 'Jewel Labs desk', deskNote: 'Approved.' });
check('a rebuild keeps the signed version in its history', (await stored('papers', 'pap1')).version === 2 && (await stored('papers', 'pap1')).versions[0].sha256 === 'bb22');
check('a rebuild never carries an approval', (await stored('papers', 'pap1')).approvedBy === null && (await stored('papers', 'pap1')).deskNote === null);
const signedV2 = { ...readyV2, status: 'signed', fileKey: 'papers/pap1/JL-EXP-1116-01-v2-signed.pdf', sha256: 'dd44', signedBy: 'SAMPLE Clerk', signedAt: '2026-11-16T14:00:00Z' };
await save('preparer', 'papers', 'pap1', signedV2);
await fails(save('preparer', 'papers', 'pap1', { ...signedV2, version: 3, status: 'ready_to_sign', fileKey: 'papers/pap1/v3.pdf', versions: [{ version: 3, fileKey: 'papers/pap1/v3.pdf', status: 'ready_to_sign' }] }), /keep the signed version/, 'a rebuild that drops the signed version');
await fails(save('preparer', 'papers', 'pap1', heldV1), /newer version/, 'go back to an older version');
// A held pack the house fixes: the agents build a new version, which may be ready to sign (the rules ran again).
await save('preparer', 'papers', 'pap2', { ...heldV1, deskNote: null });
await save('preparer', 'papers', 'pap2', { ...heldV1, version: 2, status: 'ready_to_sign', versions: [...heldV1.versions, { version: 2, status: 'ready_to_sign' }] });
check('a new version of a held paper may be ready to sign (the house fixed the papers)', (await stored('papers', 'pap2')).status === 'ready_to_sign');
// The desk holds a pack while the house still has the ready copy: signing that copy is refused.
const readyP3 = { ...heldV1, status: 'ready_to_sign', versions: [{ version: 1, status: 'ready_to_sign' }] };
await save('preparer', 'papers', 'pap3', readyP3);
await save('desk', 'papers', 'pap3', { ...readyP3, status: 'held_for_review', deskNote: 'Fix the KP number.', heldBy: 'SAMPLE desk', heldAt: '2026-11-16T15:00:00Z' });
await fails(save('preparer', 'papers', 'pap3', { ...readyP3, status: 'signed', signedBy: 'SAMPLE Clerk', signedAt: '2026-11-16T15:01:00Z' }), /held for review/, 'sign the stale copy of a held paper');
await save('preparer', 'papers', 'pap3', { ...readyP3, version: 2, status: 'held_for_review', heldBy: null, heldAt: null, versions: [{ version: 1, status: 'held_for_review' }, { version: 2, status: 'held_for_review' }] });
check('a rebuild keeps the record of an earlier hold', (await stored('papers', 'pap3')).heldBy === 'SAMPLE desk' && (await stored('papers', 'pap3')).deskNote === null);
await save('preparer', 'papers', 'pap4', { ...readyP3, status: 'signed', signedBy: 'SAMPLE Clerk', signedAt: '2026-11-16T16:00:00Z', heldBy: 'Jewel Labs desk' });
check('a paper signed while offline still saves, without desk fields', (await stored('papers', 'pap4')).status === 'signed' && (await stored('papers', 'pap4')).heldBy === null);

// The shipment's desk approval is the desk's alone.
await save('preparer', 'shipments', 'shp1', { ref: 'EXP/26-27/041', status: 'held_for_review', deskApproved: { basis: 'b1', by: 'Jewel Labs desk' } });
check('a new shipment cannot carry a desk approval', (await stored('shipments', 'shp1')).deskApproved === null);
await save('desk', 'shipments', 'shp1', { ref: 'EXP/26-27/041', status: 'ready_to_sign', deskApproved: { basis: 'b1', by: 'SAMPLE desk', at: '2026-11-16T10:00:00Z' } });
await save('preparer', 'shipments', 'shp1', { ref: 'EXP/26-27/041', status: 'ready_to_sign', answers: { 'kp.certificateNumber': 'KP-1' } });
check('saving an older copy keeps the desk approval', (await stored('shipments', 'shp1')).deskApproved?.by === 'SAMPLE desk' && (await stored('shipments', 'shp1')).answers['kp.certificateNumber'] === 'KP-1');
await save('preparer', 'shipments', 'shp1', { ref: 'EXP/26-27/041', status: 'ready_to_sign', deskApproved: { basis: 'other', by: 'Jewel Labs desk' } });
check('a preparer cannot change the desk approval', (await stored('shipments', 'shp1')).deskApproved?.basis === 'b1');

// Messages that speak as the desk.
await save('preparer', 'messages', 'msg1', { from: { type: 'person', name: 'SAMPLE Clerk', role: 'house' }, to: 'desk', text: 'Please check EXP/041' });
await fails(save('preparer', 'messages', 'msg2', { from: { type: 'person', name: 'Jewel Labs', role: 'desk' }, to: 'house', text: 'Approved' }), /as the desk/, 'preparer posts as the desk');
await fails(save('preparer', 'messages', 'msg3', { from: 'desk', to: 'house', text: 'Approved' }), /as the desk/, 'preparer posts as "desk"');
await fails(save('preparer', 'messages', 'msg4', { from: { type: 'person', name: 'SAMPLE', role: 'house' }, kind: 'desk', text: 'Approved' }), /as the desk/, 'preparer posts a desk kind');
await save('desk', 'messages', 'msg5', { from: { type: 'person', name: 'SAMPLE desk', role: 'desk' }, to: 'house', kind: 'desk', text: 'Approved.' });
await fails(save('preparer', 'messages', 'msg5', { from: { type: 'person', name: 'SAMPLE desk', role: 'house' }, to: 'house', text: 'Rejected.' }), /cannot be changed/, 'rewrite a desk message');
await fails(removeRecord('preparer', 'messages', 'msg5'), /cannot be removed/, 'remove a desk message');
check('house messages and desk messages are saved', (await stored('messages', 'msg1')) && (await stored('messages', 'msg5')).text === 'Approved.');

// The audit trail is add-only.
const entry = { at: '2026-11-16T10:00:00Z', actor: { type: 'agent', name: 'Origin' }, action: 'checked', detail: 'Checked EXP/041' };
await save('preparer', 'activity', 'act1', entry);
await save('preparer', 'activity', 'act1', entry); // the same entry sent again (a retry)
await fails(save('preparer', 'activity', 'act1', { ...entry, detail: 'Nothing happened' }), /activity log cannot be changed/, 'edit the activity log');
await fails(removeRecord('preparer', 'activity', 'act1'), /activity log cannot be changed/, 'remove from the activity log');
await fails(as('preparer', () => q(`update records set collection = 'checks' where workspace_id = $1 and collection = 'activity' and id = 'act1'`, [W])), /cannot be moved/, 'move an activity row');
check('the activity entry is unchanged', (await stored('activity', 'act1')).detail === 'Checked EXP/041');

// Everything else stays as free as before: the agents replace checks on every run.
await save('preparer', 'checks', 'chk1', { shipmentId: 'shp1', severity: 'fail' });
await save('preparer', 'checks', 'chk1', { shipmentId: 'shp1', severity: 'pass' });
check('checks are replaced and removed as before', (await removeRecord('preparer', 'checks', 'chk1')).length === 1);
await fails(as('preparer', () => q(`insert into records (workspace_id, collection, id, data) values ($1, 'documents', 'bad', '[]')`, [W])), /JSON object/, 'a record that is not an object');

// Generated papers are write-once in Storage.
const paperFile = `${W}/papers/pap1/JL-EXP-1116-01-v1-signed.pdf`;
const docFile = `${W}/docs/d1/SAMPLE invoice.pdf`;
await as('preparer', () => q(`insert into storage.objects (bucket_id, name) values ('documents', $1)`, [paperFile]));
check('a new paper file is stored', (await q(`select name from storage.objects where name = $1`, [paperFile])).length === 1);
check('a paper file cannot be replaced', (await as('preparer', () => q(`update storage.objects set owner = null where name = $1 returning name`, [paperFile]))).length === 0);
await fails(as('preparer', () => q(`insert into storage.objects (bucket_id, name) values ('documents', $1) on conflict (bucket_id, name) do update set owner = excluded.owner`, [paperFile])), /row-level security/, 'upload over a paper file');
check('or removed', (await as('preparer', () => q(`delete from storage.objects where name = $1 returning name`, [paperFile]))).length === 0);
check('document files can still be replaced', (await as('preparer', () => q(`update storage.objects set owner = null where name = $1 returning name`, [docFile]))).length === 1);
check('Jewel Labs can replace a paper file', (await as('desk', () => q(`update storage.objects set owner = null where name = $1 returning name`, [paperFile]))).length === 1);

// ---------- 0005: invites ----------
const hire = '00000000-0000-4000-8000-000000000011';
const newHire = '00000000-0000-4000-8000-000000000012';
ids.hire = hire;
await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'hire@sample.example', '{"name":"SAMPLE hire"}')`, [hire]);
await q(`insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ($1, 'new.hire@sample.example', '{}', null)`, [newHire]);
const redeem = async (code, user) => (await as('service', () => q(`select redeem_invite($1, $2) as ws`, [code, user])))[0].ws;

await fails(as('desk', () => q(`select create_invite($1, 'desk')`, [W])), /create_desk_invite/, 'desk invite through create_invite');
await fails(as('owner', () => q(`select create_desk_invite($1, 'hire@sample.example')`, [W])), /Only Jewel Labs can invite desk/, 'owner makes a desk invite');
await fails(as('desk', () => q(`select create_desk_invite($1, 'not an email')`, [W])), /email address/, 'desk invite without an email');
const deskCode = (await as('desk', () => q(`select create_desk_invite($1, ' Hire@Sample.example ') as code`, [W])))[0].code;
const deskInvite = (await q(`select role, email, max_uses, expires_at from invites where code = $1`, [deskCode]))[0];
check('a desk invite names one person, works once, for 4 hours', deskInvite.role === 'desk' && deskInvite.email === 'hire@sample.example' && deskInvite.max_uses === 1 && new Date(deskInvite.expires_at) - Date.now() <= 4 * 3600 * 1000 + 60000);
check('owners do not see desk invites', !(await as('owner', () => q(`select code from invites`))).some((i) => i.code === deskCode));
check('a desk invite does not work for another account', (await redeem(deskCode, ids.outsider)) === null);
check('it makes the named person desk staff', (await redeem(deskCode, hire)) === W && (await q(`select is_desk from profiles where user_id = $1`, [hire]))[0].is_desk === true);
check('it works only once', (await q(`select uses from invites where code = $1`, [deskCode]))[0].uses === 1 && (await redeem(deskCode, ids.outsider)) === null);
const unconfirmedCode = (await as('desk', () => q(`select create_desk_invite($1, 'new.hire@sample.example') as code`, [W])))[0].code;
check('the email must be confirmed', (await redeem(unconfirmedCode, newHire)) === null && (await q(`select is_desk from profiles where user_id = $1`, [newHire]))[0].is_desk === false);
await q(`insert into invites (code, workspace_id, role) values ('DESKOLD2', $1, 'desk')`, [W]); // as 0002 allowed: any account, 20 uses
check('a desk invite from before 0005 no longer works', (await redeem('DESKOLD2', newHire)) === null);
const grants = await q(`select user_id, is_desk, via from desk_grants order by id`);
check('desk grants are on record: by invite and by SQL', grants.some((g) => g.user_id === hire && g.is_desk && g.via === `desk invite ${deskCode}`) && grants.some((g) => g.user_id === ids.desk && g.via.startsWith('sql')));
check('only desk staff read them', (await as('owner', () => q(`select id from desk_grants`))).length === 0 && (await as('desk', () => q(`select id from desk_grants`))).length === grants.length);

const spare = (await as('owner', () => q(`select create_invite($1, 'viewer') as code`, [W])))[0].code;
check('a preparer cannot withdraw a code', (await as('preparer', () => q(`select revoke_invite($1) as ok`, [spare])))[0].ok === false);
check('an unknown code gets the same answer', (await as('preparer', () => q(`select revoke_invite('ZZZZZZZZ') as ok`)))[0].ok === false);
check('an owner cannot withdraw a desk invite', (await as('owner', () => q(`select revoke_invite($1) as ok`, [unconfirmedCode])))[0].ok === false);
check('the owner withdraws a code', (await as('owner', () => q(`select revoke_invite($1) as ok`, [spare.toLowerCase()])))[0].ok === true);
check('a withdrawn code no longer works', (await redeem(spare, newHire)) === null);

const kept = (await as('owner', () => q(`select create_invite($1, 'viewer') as code`, [W])))[0].code;
await as('hire', () => q(`delete from members where workspace_id = $1 and user_id = $2`, [W, hire]));
check('leaving on your own keeps the house codes', (await q(`select expires_at > now() as open from invites where code = $1`, [kept]))[0].open === true);
check('the owner removes a member', (await as('owner', () => q(`delete from members where workspace_id = $1 and user_id = $2 returning user_id`, [W, ids.preparer]))).length === 1);
check('removing someone expires the house codes', (await q(`select count(*)::int as n from invites where workspace_id = $1 and expires_at > now()`, [W]))[0].n === 0);
check('so they cannot come back with the code they used', (await as('preparer', () => q(`select * from join_with_code($1)`, [prepCode])))[0].id === null);
await q(`select insert_invite($1, 'viewer', null, 20, now() + interval '1 day')`, [svcHouse.id]);
await q(`delete from workspaces where id = $1`, [svcHouse.id]); // the SQL editor deletes a house with members and codes
check('a house with members and codes can still be deleted', (await q(`select id from workspaces where id = $1`, [svcHouse.id])).length === 0);

// ---------- 0006: sign-up ceiling ----------
const recentTries = Number((await q(`select count(*) as n from signup_attempts where at > now() - interval '1 hour'`))[0].n);
const tryFrom = async (hash, perNetwork, all) => (await as('service', () => q(`select note_signup_attempt($1, $2, $3) as ok`, [hash, perNetwork, all])))[0].ok;
const network = [await tryFrom('net-a', 2, recentTries + 10), await tryFrom('net-a', 2, recentTries + 10), await tryFrom('net-a', 2, recentTries + 10)];
check('one network gets its tries per hour', JSON.stringify(network) === JSON.stringify([true, true, false]));
check('a refused try is not counted', Number((await q(`select count(*) as n from signup_attempts where ip_hash = 'net-a'`))[0].n) === 2);
const everyone = [await tryFrom('net-b', 10, recentTries + 3), await tryFrom('net-c', 10, recentTries + 3)];
check('all networks together stop at the ceiling', JSON.stringify(everyone) === JSON.stringify([true, false]));
await fails(as('anon', () => q(`select note_signup_attempt('x', 10, 10)`)), /permission denied/, 'anon counts sign-ups');

// ---------- 0007: paper numbers ----------
const reserveRef = (who, stem, floor) => as(who, () => q(`select reserve_paper_ref($1, $2, $3) as n`, [W, stem, floor]));
check('the first paper of a day gets number 1', (await reserveRef('owner', 'JL-EXP-1116-', 0))[0].n === 1);
check('the next one gets 2, whoever asks', (await reserveRef('owner', 'JL-EXP-1116-', 0))[0].n === 2);
check('a computer that saw a higher number gets one above it', (await reserveRef('owner', 'JL-EXP-1116-', 5))[0].n === 6);
check('a lower floor never gives a number twice', (await reserveRef('owner', 'JL-EXP-1116-', 1))[0].n === 7);
check('each kind and day counts on its own', (await reserveRef('owner', 'JL-DDS-1116-', null))[0].n === 1);
check('desk staff may build papers too', (await reserveRef('desk', 'JL-EXP-1116-', 0))[0].n === 8);
await fails(reserveRef('viewer', 'JL-EXP-1116-', 0), /cannot build papers/, 'a viewer reserves a number');
await fails(reserveRef('outsider', 'JL-EXP-1116-', 0), /cannot build papers/, 'an outsider reserves a number');
await fails(reserveRef('owner', 'not a ref', 0), /not a paper number/, 'a bad stem');
await fails(as('anon', () => q(`select reserve_paper_ref($1, 'JL-EXP-1116-', 0)`, [W])), /permission denied/, 'anon reserves a number');
await fails(as('owner', () => q(`select * from paper_refs`)), /permission denied/, 'the table is read directly');

console.log('ALL SQL CHECKS PASSED');
await db.close();
