// App-wide settings. Public values only: the Supabase URL and publishable key are safe to ship
// (row-level security protects the data). Never put an OpenAI key here.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'Jewel Labs';
// The app's version is package.json's "version" (app.getVersion() in Electron); it is not repeated here.

// Filled in when the Jewel Labs Supabase project is created (see backend/supabase/README.md).
export const SUPABASE_URL = process.env.JL_SUPABASE_URL || 'https://wcywvpnrlllpzlauofeb.supabase.co';
// Publishable key: designed to be public. Row-level security decides what each signed-in user can read.
// JL_SUPABASE_ANON_KEY is the old name of the switch, still read.
export const SUPABASE_PUBLISHABLE_KEY = process.env.JL_SUPABASE_PUBLISHABLE_KEY || process.env.JL_SUPABASE_ANON_KEY
  || 'sb_publishable_YIYAR-e9u6SgBRHPu_xgEg_5DUk7Yuy';

// OpenAI models, cheapest capable first. The client falls back down the list if a model is not available.
// Every model listed must also be allowed by the Jewel Labs AI proxy (its AI_MODELS secret, backend/supabase/README.md).
export const AI_MODELS = ['gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1-mini'];
// reasoning_effort per model family (gpt-5.4 rejects 'minimal'; gpt-5 accepts it; 4.x has none).
export const AI_REASONING = { 'gpt-5.4-mini': 'none', 'gpt-5-mini': 'minimal' };
export const AI_MAX_PARALLEL = 3;
// The Jewel Labs AI proxy refuses request bodies bigger than this: MAX_BODY_BYTES in
// backend/supabase/functions/ai/index.ts (a unit test checks the two agree).
export const AI_PROXY_MAX_BODY_BYTES = 25 * 1024 * 1024;

export const MAILBOX_POLL_MINUTES = 5;
export const OFAC_MAX_AGE_HOURS = 24;

// Repo root (works from src/core in dev and inside app.asar when packaged).
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
export const SAMPLES_DIR = path.join(ROOT_DIR, 'samples', 'sample-shipment');

export const GITHUB_REPO = 'aarushkandukoori/jewel-labs-desk';
export const SITE_URL = 'https://aarushkandukoori.github.io/jewel-labs-desk/';
