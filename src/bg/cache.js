// Two-tier cache in chrome.storage.local.
//
// Open Library results describe which translations exist, which does not change, so they
// are kept for months. Catalogue verdicts contain loan state, which changes daily, so
// they expire in hours. Both are keyed on the normalized title/author of the book.

const DAY = 24 * 60 * 60 * 1000;

// Bump whenever a change alters what a cached verdict would say — a matching fix, a new
// field, a different colour rule. Cached entries outlive the code that wrote them, so
// without this a fixed bug keeps being shown from storage until its tier expires.
export const CACHE_VERSION = 2;
const VERSION_KEY = 'cacheVersion';

export const TIERS = {
  bridge: { prefix: 'ol:', ttl: 90 * DAY },
  holdings: { prefix: 'h:', ttl: 6 * 60 * 60 * 1000 },
  verdict: { prefix: 'av:', ttl: 6 * 60 * 60 * 1000 },
};

const keyFor = (tier, key) => `${TIERS[tier].prefix}${key}`;

export async function read(tier, key) {
  const storageKey = keyFor(tier, key);
  const stored = (await chrome.storage.local.get(storageKey))[storageKey];
  if (!stored) return null;
  if (Date.now() - stored.at > TIERS[tier].ttl) {
    await chrome.storage.local.remove(storageKey);
    return null;
  }
  return stored.value;
}

export async function write(tier, key, value) {
  await chrome.storage.local.set({ [keyFor(tier, key)]: { at: Date.now(), value } });
}

/** Run `produce` only on a cache miss. */
export async function through(tier, key, produce) {
  const cached = await read(tier, key);
  if (cached !== null) return { value: cached, cached: true };
  const value = await produce();
  await write(tier, key, value);
  return { value, cached: false };
}

/** Wipe everything written by an older build. Call once before serving any lookup. */
export async function ensureVersion() {
  const stored = (await chrome.storage.local.get(VERSION_KEY))[VERSION_KEY];
  if (stored === CACHE_VERSION) return { cleared: 0 };

  const cleared = await clear();
  await chrome.storage.local.set({ [VERSION_KEY]: CACHE_VERSION });
  return { cleared };
}

export async function clear(tier) {
  const all = await chrome.storage.local.get(null);
  const prefixes = tier ? [TIERS[tier].prefix] : Object.values(TIERS).map(({ prefix }) => prefix);
  const doomed = Object.keys(all).filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
  if (doomed.length) await chrome.storage.local.remove(doomed);
  return doomed.length;
}
