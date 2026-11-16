// App-wide settings. Public values only: the Supabase URL and publishable key are safe to ship
// (row-level security protects the data). Never put an OpenAI key here.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'Jewel Labs';
export const APP_VERSION = '1.0.0';

// Filled in when the Jewel Labs Supabase project is created (see backend/supabase/README.md).
export const SUPABASE_URL = process.env.JL_SUPABASE_URL || 'https://wcywvpnrlllpzlauofeb.supabase.co';
// Publishable key: designed to be public. Row-level security decides what each signed-in user can read.
export const SUPABASE_ANON_KEY = process.env.JL_SUPABASE_ANON_KEY || 'sb_publishable_YIYAR-e9u6SgBRHPu_xgEg_5DUk7Yuy';

// OpenAI models, cheapest capable first. The client falls back down the list if a model is not available.
export const AI_MODELS = ['gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1-mini'];
// reasoning_effort per model family (gpt-5.4 rejects 'minimal'; gpt-5 accepts it; 4.x has none).
export const AI_REASONING = { 'gpt-5.4-mini': 'none', 'gpt-5-mini': 'minimal' };
export const AI_MAX_PARALLEL = 3;

export const MAILBOX_POLL_MINUTES = 5;
export const OFAC_MAX_AGE_HOURS = 24;

// Repo root (works from src/core in dev and inside app.asar when packaged).
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
export const SAMPLES_DIR = path.join(ROOT_DIR, 'samples', 'sample-shipment');

export const GITHUB_REPO = 'aarushkandukoori/jewel-labs-desk';
export const SITE_URL = 'https://aarushkandukoori.github.io/jewel-labs-desk/';
