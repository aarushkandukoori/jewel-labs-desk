// Checks an OpenAI API key before it is stored, so a mistyped key shows up right away
// instead of as failed reads later. The key itself is never logged.

export function looksLikeOpenAIKey(key) {
  return typeof key === 'string' && /^sk-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

// Returns { ok: true } or { ok: false, reason }. When OpenAI cannot be reached we still accept the
// key (with a warning): the person may be offline for a moment.
export async function checkOpenAIKey(key, { fetch = globalThis.fetch, timeoutMs = 10000 } = {}) {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { ok: false, reason: 'OpenAI did not accept this key. Check that it was copied in full.' };
    if (res.ok) return { ok: true };
    return { ok: true, warning: `OpenAI answered ${res.status}. The key was saved; reading may still fail.` };
  } catch {
    return { ok: true, warning: 'Could not reach OpenAI to test the key. It was saved anyway.' };
  }
}
