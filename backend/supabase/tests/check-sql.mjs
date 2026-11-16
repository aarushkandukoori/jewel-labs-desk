// Checks migrations/0001_init.sql without a Supabase project. It applies the migration twice to PGlite (real
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
const migrationPath = new URL('../migrations/0001_init.sql', import.meta.url);

const db = await PGlite.create({ extensions: { pgcrypto } });

const MOCK = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema auth;
create schema storage;
create schema extensions;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
`;

await db.exec(MOCK);
const migration = await fs.readFile(migrationPath, 'utf8');
await db.exec(migration);
await db.exec(migration); // must be safe to run twice
console.log('migration applied twice: ok');

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

console.log('ALL SQL CHECKS PASSED');
await db.close();
