# Jewel Labs backend (Supabase)

The desktop app works on its own with local files. When people sign in, a house's records and files live in
Supabase instead, so everyone at the house (and the Jewel Labs desk) sees the same shipments, and the agents can
use the Jewel Labs OpenAI key without the key ever shipping in the app.

```
backend/supabase/
  config.toml                         CLI settings (which functions check the sign-in token)
  migrations/0001_init.sql            tables, row-level security, functions, realtime, storage bucket
  migrations/0002_desk_invites.sql    redeeming a desk invite makes the person desk staff
  migrations/0003_ai_limits.sql       AI limits per house and per person, in calls and tokens; trial houses
  migrations/0004_record_guards.sql   the desk's decisions, signed papers and the activity log stay as written
  migrations/0005_invites.sql         desk invites for one named person; withdrawing codes; desk access audit
  migrations/0006_signup_limits.sql   a ceiling on sign-ups from all networks together
  migrations/0007_paper_refs.sql      paper numbers handed out by the server, so two computers never give the same ref
  functions/ai/index.ts               OpenAI proxy: checks the person and the house, limits, model list, usage
  functions/signup/index.ts           sign-up with or without an invite code (no confirmation email needed)
  tests/check-sql.mjs                 runs every migration in PGlite and tries the security rules as different people
  tests/check-functions.mjs           runs both functions under Deno against a local stand-in for Supabase and OpenAI
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

## 2. Apply the database migrations

```sh
supabase --workdir backend db push
```

This applies every file in `migrations/` that the project does not have yet, in order. Or paste the files into the
dashboard SQL editor one after another, in order (`0001`, `0002`, `0003`, ...). Each file is safe to run again.

Apply new migrations before deploying the Edge Functions that go with them (section 3): the functions call the
SQL functions the migrations add. The migrations keep the older SQL functions, so the functions deployed before
keep working in between.

They create:

| table | what it holds |
|-------|---------------|
| `profiles` | one row per account: email, name, `is_desk` (Jewel Labs staff), `is_test` |
| `workspaces` | one row per house: name, environment (`sandbox` or `live`), `ai_approved`, settings in `data`, `rev` |
| `members` | who belongs to which house, with role `owner`, `preparer`, `viewer` or `desk` |
| `invites` | 8-character invite codes: 14 days and 20 uses; a desk invite names one email, works once, for 4 hours |
| `records` | every record of every collection: `(workspace_id, collection, id)`, the record in `data`, `rev`, `updated_at`, `updated_by` |
| `ai_usage`, `ai_user_usage` | AI calls and tokens per house and per person, per day (UTC) |
| `worker_leases` | which computer runs the agents for a house right now |
| `join_attempts`, `signup_attempts` | counters that slow down code guessing and sign-up floods |
| `desk_grants` | every time someone was given or lost desk access: who, when, how |

Who may do what (row-level security and triggers):

- Members read their house. Owners, preparers and desk members also change its records, files and settings.
  Viewers only read.
- Desk users (`profiles.is_desk = true`) read and change every house, so they can approve or hold papers anywhere.
- Some things only the desk or a signature decides. For everyone else the database keeps the desk's fields as the
  desk wrote them (`shipments.deskApproved`; `approvedBy`, `approvedAt`, `deskNote`, `heldBy`, `heldAt` on papers),
  refuses messages that speak as the desk, keeps a paper held for review held until the desk releases it, keeps a
  signed or sent paper exactly as signed (only the sending details may change), never lets a paper go back to an
  older version, and keeps the activity log add-only. Generated paper files (`<house>/papers/...`) are write-once.
  The rules themselves run in the app, so a writer can still save passing checks or build a new version of a held
  paper; `records.updated_by` shows who saved each row.
- Only the owner or a desk user can create invite codes, withdraw them (`revoke_invite`), and switch a house between
  sandbox and live. Removing someone from a house expires its open codes.
- Only Jewel Labs can approve a house for the full AI allowance (`ai_approved`). Houses the desk creates start
  approved; houses made by sign-up start in trial.
- Nobody can make themselves a desk user: people may change only their own `name` in `profiles`.

Functions the app calls: `create_house`, `update_house`, `create_invite`, `revoke_invite`, `join_with_code`,
`list_my_workspaces`, `list_records`, `acquire_lease`, `release_lease`. Desk staff (or the SQL editor) also have
`create_desk_invite` and `approve_house_ai`. Functions only the Edge Functions may call (service role):
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
ALLOW_OPEN_SIGNUP=false     # recommended. Unset or true = anyone can sign up and get a trial house
# optional (the defaults are shown):
AI_MODELS=gpt-5.4-mini,gpt-5-mini,gpt-4.1-mini,gpt-4o-mini  # must include every model in src/core/config.js AI_MODELS
SIGNUP_HOURLY_CAP=100       # sign-up tries per hour from all networks together (each network also gets 10)
# daily AI limits (UTC days); see "Limits worth knowing"
AI_DAILY_CAP=600            # calls per house Jewel Labs approved
AI_DAILY_TOKENS=10000000    # input + output tokens per approved house
AI_TRIAL_DAILY_CAP=50       # calls per house not approved yet
AI_TRIAL_DAILY_TOKENS=1000000
AI_USER_DAILY_CAP=600       # calls per person across all their houses (desk staff are not limited)
AI_USER_DAILY_TOKENS=10000000
# OPENAI_CHAT_URL is only for local tests of the ai function; leave it unset in production.
```

```sh
supabase --workdir backend secrets set --env-file backend/supabase/.env
```

Or add them in the dashboard under **Edge Functions > Secrets**. No redeploy is needed after changing a secret.
`SUPABASE_URL` and the service keys are provided to the functions by Supabase automatically.

When `AI_MODELS` is set it replaces the list in `functions/ai/index.ts`. A model the app asks for that is not on
the list gets a 404, and the app moves on to its next model; keep the app's first model on the list or every call
starts with a refusal. Write the value you set here, so the next person sets the same.

With `ALLOW_OPEN_SIGNUP=true` anyone can create an account (already confirmed, for any email address) and a trial
house. Keep it `false` until sign-up has more protection (an email check, a CAPTCHA). The test scripts that make
their own accounts (`test/e2e/flow.spec.mjs` flow B, `node scripts/eval.js --proxy`) need it `true`, or an invite
code.

## 5. Auth settings

In **Authentication > Sign In / Providers**:

- Keep **Email** sign-in on.
- Turn off **Allow new users to sign up**. The `signup` function still creates accounts (it uses the admin API),
  but nobody can skip its checks and rate limit by calling the public sign-up endpoint.
- Confirming emails can stay on: accounts from the `signup` function are created already confirmed. That also
  means nobody proved they own the address, so never give anyone access because of their email alone (section 6).

## 6. Make someone a desk user (Jewel Labs staff)

Desk users read and change every house. Give desk access to a person you have spoken to, never to whichever account
holds an email address: anyone can create an account for any address first.

The usual way is a desk invite for that person's email. In the SQL editor (or as a desk user):

```sql
select public.create_desk_invite('<any house id>', 'name@jewellabs.io');
```

Send the code to the person yourself (not by a shared channel). It works once, for 4 hours, and only for an account
with that email address. They sign up in the app with the code, or sign in and enter it. If the email is already
taken by an account they did not make, stop and find out why.

Or, for someone who already has an account: ask them for their user id (or check it with them in **Authentication >
Users**), then:

```sql
update public.profiles set is_desk = true where user_id = '<their user id>';
```

To take desk access away, turn the flag off and remove the desk memberships it came with (the app treats a `desk`
member as desk staff):

```sql
update public.profiles set is_desk = false where user_id = '<their user id>';
delete from public.members where user_id = '<their user id>' and role = 'desk';
```

Every change of `is_desk` is written to `public.desk_grants`.

To mark a test account (left out of metrics): `update public.profiles set is_test = true where user_id = '...';`

## 7. Approve a house for the full AI allowance

Houses made by sign-up start in trial (`AI_TRIAL_DAILY_CAP` calls a day). Once Jewel Labs knows the house:

```sql
select public.approve_house_ai('<house id>');          -- or approve_house_ai('<house id>', false) to take it back
```

Houses the desk creates (Desk > Onboard the house) start approved, and houses that existed before `0003` kept
their allowance.

## 8. Point the app at the project

Either set environment variables before starting the app in development (an installed copy ignores them):

```sh
export JL_SUPABASE_URL=https://<project-ref>.supabase.co
export JL_SUPABASE_PUBLISHABLE_KEY=<publishable key>
```

or fill `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in `src/core/config.js`. Both values are public. Never put the
OpenAI key or a secret/service key in the app.

## 9. Check that it works

```sh
URL=https://<project-ref>.supabase.co
KEY=<publishable or anon key>

# A new account with its own sandbox house (answers {"ok":true,"workspaceId":"..."}); needs ALLOW_OPEN_SIGNUP=true
# or an "inviteCode". Use a mailbox you own; the account is real.
curl -s "$URL/functions/v1/signup" -H "apikey: $KEY" -H 'Content-Type: application/json' \
  -d '{"email":"you+test@example.com","password":"a long test password","name":"Test person"}'
```

Then sign in with that account in the app, open the house, and ask the agents something. In the dashboard:
**Table editor > records** fills up as the agents work, and **Edge Functions > ai > Logs** shows one line per AI call
(user, house, model, status, tokens; never the content). **Edge Functions > signup > Logs** says once per instance
which header the network address came from; it should be `cf-connecting-ip`.

## Check the backend without a project

Two scripts check this folder on your own computer. Neither talks to Supabase or OpenAI.

```sh
# Every migration and its security rules, in PGlite (Postgres compiled to WebAssembly). About 110 checks.
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
  Every save bumps `rev` in the database, which is how the app ignores old or repeated changes. A change the
  database refuses (for example signing a paper the desk has just held) is dropped and the server's copy shown.
  `src/core/store/cloud-api.js` holds the few calls it makes to Supabase.
- The AI client calls `POST <project URL>/functions/v1/ai` with `Authorization: Bearer <access token>`,
  `x-jl-workspace: <house id>` and an OpenAI Chat Completions body. The proxy forwards only the model, messages,
  `response_format`, `temperature` and `reasoning_effort` (`none`, `minimal` or `low`), with
  `max_completion_tokens` at most 16000. The answer is OpenAI's own JSON and status. Errors made by the proxy use
  OpenAI's shape: `{ "error": { "message", "type", "code" } }`; 429 with code `daily_limit` means a daily limit was
  reached (the message says which), and 404 with code `model_not_allowed` means the model is not on the list.

## Limits worth knowing

- AI, per UTC day: an approved house gets 600 calls and 10 million tokens, a trial house 50 calls and 1 million
  tokens, and one person 600 calls and 10 million tokens across all their houses (desk staff have no person limit).
  A call is refused once a limit is reached, so one large call can go past a token limit once.
- Requests to the AI proxy are at most 25 MB (page images are sent inline), counted as they arrive.
- Realtime cannot filter deletes, so every signed-in listener receives the key (house id, collection, record id)
  of every deleted record, never its contents. The app ignores deletes for other houses.
- Realtime leaves out very large rows' contents; the app then fetches the row.
- Files up to 50 MB each (the bucket limit).
- Deleting a house in SQL removes its records, members and invites, but not its files in Storage.
