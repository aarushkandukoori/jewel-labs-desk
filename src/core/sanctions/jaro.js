// Jaro-Winkler similarity between two strings: 1 means identical, 0 means nothing in common.
// It is good at names: it forgives a swapped or missing letter, and it rewards a shared start
// ("RUHMEER" vs "RUMHEER" scores about 0.96).

const PREFIX_SCALE = 0.1; // Winkler's standard bonus per shared leading letter
const MAX_PREFIX = 4;
const BOOST_THRESHOLD = 0.7; // only strings that are already similar get the prefix bonus

export function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const jaro = jaroSimilarity(a, b);
  if (jaro <= BOOST_THRESHOLD) return jaro;
  let prefix = 0;
  while (prefix < MAX_PREFIX && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * PREFIX_SCALE * (1 - jaro);
}

/** Plain Jaro similarity: shared letters that sit close together, minus letters that are out of order. */
export function jaroSimilarity(a, b) {
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aUsed = new Uint8Array(a.length);
  const bUsed = new Uint8Array(b.length);

  // 1. Count letters of a that also appear in b, no further apart than `window`.
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const from = Math.max(0, i - window);
    const to = Math.min(b.length - 1, i + window);
    for (let j = from; j <= to; j++) {
      if (bUsed[j] || a[i] !== b[j]) continue;
      aUsed[i] = 1;
      bUsed[j] = 1;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  // 2. Count matched letters that are in a different order (each swap counts twice, so halve it).
  let outOfOrder = 0;
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aUsed[i]) continue;
    while (!bUsed[j]) j++;
    if (a[i] !== b[j]) outOfOrder++;
    j++;
  }
  const transpositions = outOfOrder / 2;

  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}
