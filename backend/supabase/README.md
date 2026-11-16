# Jewel Labs backend (Supabase)

The desktop app works on its own with local files. When people sign in, a house's records and files live in
Supabase instead, so everyone at the house (and the Jewel Labs desk) sees the same shipments, and the agents can
use the Jewel Labs OpenAI key without the key ever shipping in the app.

```
backend/supabase/
  config.toml                 CLI settings (which functions check the sign-in token)
  migrations/0001_init.sql    tables, row-level security, functions, realtime, storage bucket
  functions/ai/index.ts       OpenAI proxy: checks the person and the house, daily cap, model list, usage
  functions/signup/index.ts   sign-up with or without an invite code (no confirmation email needed)
  tests/check-sql.mjs         runs the migration in PGlite and tries the security rules as different people
  tests/check-functions.mjs   runs both functions under Deno against a local stand-in for Supabase and OpenAI
```

Run every `supabase` command below from the repo root. `--workdir backend` points the CLI at the folder that holds
this `supabase/` folder.

## 1. Create the project

1. Create a project at https://supabase.com/dashboard (any region near the houses; Mumbai suits Surat).
2. Note three things from **Project Settings**: the project ref (the `xxxx` in `https://xxxx.supabase.co`), the
   project URL, and the **publishable** key (or the legacy `anon` key). Both keys are safe to ship in the app.
3. Install the Supabase CLI (https://supabase.com/docs/guides/cli), then:

```sh
supabase login
supabase --workdir backend link --project-ref <project-ref>
```

## 2. Apply the database migration

```sh
supabase --workdir backend db push
```

Or paste `migrations/0001_init.sql` into the dashboard SQL editor and run it. The file is safe to run again.

It creates:

| table | what it holds |
|-------|---------------|
| `profiles` | one row per account: email, name, `is_desk` (Jewel Labs staff), `is_test` |
| `workspaces` | one row per house: name, environment (`sandbox` or `live`), settings in `data`, `rev` |
| `members` | who belongs to which house, with role `owner`, `preparer`, `viewer` or `desk` |
| `invites` | 8-character invite codes (14 days, 20 uses by default) |
| `records` | every record of every collection: `(workspace_id, collection, id)`, the record in `data`, `rev`, `updated_at`, `updated_by` |
| `ai_usage` | AI calls and tokens per house per day (UTC) |
| `worker_leases` | which computer runs the agents for a house right now |
| `join_attempts`, `signup_attempts` | counters that slow down code guessing and sign-up floods |

Who may do what (row-level security):

- Members read their house. Owners, preparers and desk members also change its records, files and settings.
  Viewers only read.
- Desk users (`profiles.is_desk = true`) read and change every house, so they can approve or hold papers anywhere.
- Only the owner or a desk user can create invite codes, and switch a house between sandbox and live.
- Nobody can make themselves a desk user: people may change only their own `name` in `profiles`.

Functions the app calls: `create_house`, `update_house`, `create_invite`, `join_with_code`, `list_my_workspaces`,
`list_records`, `acquire_lease`, `release_lease`. Functions only the Edge Functions may call (service role):
`create_house_for`, `redeem_invite`, `reserve_ai_call`, `bump_ai_usage`, `note_signup_attempt`.

Realtime: `records` and `workspaces` are added to the `supabase_realtime` publication. Storage: a private bucket
`documents`; objects are named `<workspace_id>/<file key>` and follow the same member rules.

## 3. Deploy the two Edge Functions

```sh
supabase --workdir backend functions deploy ai --use-api
supabase --workdir backend functions deploy signup --no-verify-jwt --use-api
```

`--use-api` bundles the functions on Supabase's side, so Docker does not need to be running.

- `ai` is only called by signed-in people. The platform checks their token (`verify_jwt = true` in `config.toml`),
  and the function checks it again with `auth.getUser()` and checks that they belong to the house.
- `signup` is called before anyone is signed in, so it must allow calls without a token (`--no-verify-jwt`,
  also set in `config.toml`).

## 4. Set the secrets

The OpenAI key lives only here, as an Edge Function secret. Put it in a file that is never committed
(`backend/supabase/.env` is in `.gitignore`):

```sh
# backend/supabase/.env
OPENAI_API_KEY=<the Jewel Labs OpenAI key>
# optional:
AI_DAILY_CAP=600                                  # AI calls per house per day (UTC)
AI_MODELS=gpt-5-mini,gpt-4.1-mini,gpt-4o-mini     # the models the proxy allows
ALLOW_OPEN_SIGNUP=true                            # false = sign-up needs an invite code
# OPENAI_CHAT_URL is only for local tests of the ai function; leave it unset in production.
```

```sh
supabase --workdir backend secrets set --env-file backend/supabase/.env
```

Or add them in the dashboard under **Edge Functions > Secrets**. No redeploy is needed after changing a secret.
`SUPABASE_URL` and the service keys are provided to the functions by Supabase automatically.

## 5. Auth settings

In **Authentication > Sign In / Providers**:

- Keep **Email** sign-in on.
- Turn off **Allow new users to sign up**. The `signup` function still creates accounts (it uses the admin API),
  but nobody can skip its checks and rate limit by calling the public sign-up endpoint.
- Confirming emails can stay on: accounts from the `signup` function are created already confirmed.

## 6. Make someone a desk user (Jewel Labs staff)

Have them sign up in the app first, then run in the SQL editor:

```sql
update public.profiles set is_desk = true where email = 'name@jewellabs.io';
```

To mark a test account (left out of metrics): `update public.profiles set is_test = true where email = '...';`

## 7. Point the app at the project

Either set environment variables before starting the app (or the build):

```sh
export JL_SUPABASE_URL=https://<project-ref>.supabase.co
export JL_SUPABASE_ANON_KEY=<publishable or anon key>
```

or fill `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `src/core/config.js`. Both values are public. Never put the
OpenAI key or a secret/service key in the app.

## 8. Check that it works

```sh
URL=https://<project-ref>.supabase.co
KEY=<publishable or anon key>

# A new account with its own sandbox house (answers {"ok":true,"workspaceId":"..."}).
# Use a mailbox you own; the account is real.
curl -s "$URL/functions/v1/signup" -H "apikey: $KEY" -H 'Content-Type: application/json' \
  -d '{"email":"you+test@example.com","password":"a long test password","name":"Test person"}'
```

Then sign in with that account in the app, open the house, and ask the agents something. In the dashboard:
**Table editor > records** fills up as the agents work, and **Edge Functions > ai > Logs** shows one line per AI call
(user, house, model, status, tokens; never the content).

## Check the backend without a project

Two scripts check this folder on your own computer. Neither talks to Supabase or OpenAI.

```sh
# The migration and its security rules, in PGlite (Postgres compiled to WebAssembly). About 80 checks.
mkdir -p /tmp/pglite && npm install --prefix /tmp/pglite @electric-sql/pglite@0.5.14
PGLITE_DIR=/tmp/pglite node backend/supabase/tests/check-sql.mjs

# Both Edge Functions under Deno (TypeScript check, then how they answer). Needs Deno installed.
node backend/supabase/tests/check-functions.mjs
```

The SQL check uses small stand-ins for Supabase's own `auth` and `storage` schemas, so it proves the logic of the
policies and functions, not every detail of a hosted project. Run the curl check above once on the real project.

## How the app uses this

- `src/core/store/cloud.js` signs people in, lists and creates houses, makes and redeems invite codes, and holds
  the worker lease.
- `src/core/store/cloud-store.js` keeps a house's records in memory and on disk, sends changes through an outbox
  (retried while offline), listens to Realtime for other computers' changes, and reloads after reconnecting.
  Every save bumps `rev` in the database, which is how the app ignores old or repeated changes.
  `src/core/store/cloud-api.js` holds the few calls it makes to Supabase.
- The AI client calls `POST <project URL>/functions/v1/ai` with `Authorization: Bearer <access token>`,
  `x-jl-workspace: <house id>` and an OpenAI Chat Completions body. The answer is OpenAI's own JSON and status.
  Errors made by the proxy use OpenAI's shape: `{ "error": { "message", "type", "code" } }`; 429 with code
  `daily_limit` means the house used its calls for today.

## Limits worth knowing

- Realtime cannot filter deletes, so every signed-in listener receives the key (house id, collection, record id)
  of every deleted record, never its contents. The app ignores deletes for other houses.
- Realtime leaves out very large rows' contents; the app then fetches the row.
- Files up to 50 MB each (the bucket limit).
- Deleting a house in SQL removes its records, members and invites, but not its files in Storage.
