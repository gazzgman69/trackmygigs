// UK postcode geocoder backed by postcodes.io (free, no key, no signup).
//
// Design decisions (see roadmap Phase VI for context):
//   1. We ONLY hit postcodes.io at write time (user saves profile / gig
//      create or edit), never on broadcast send. Once a postcode is resolved
//      we cache lat/lng on the row that owns it.
//   2. In-process LRU keeps hot lookups free even during the single write.
//      postcodes.io fair-use is ~3000 req / 10s per IP; we shouldn't come
//      close, but being a good neighbour matters for free services.
//   3. Self-host fallback via env POSTCODES_IO_BASE, in case postcodes.io
//      ever rate-limits TrackMyGigs or goes down. Default is the public host.
//   4. Invalid postcode → returns null (no throw). Callers are expected to
//      either require a valid postcode (signup / gig save with venue) or
//      silently skip the geocode and let distance filters fall open.

const BASE = (process.env.POSTCODES_IO_BASE || 'https://api.postcodes.io').replace(/\/+$/, '');

// Tiny LRU. Keyed by normalised postcode.
const CACHE_MAX = 500;
const cache = new Map();
function cacheGet(k) {
  if (!cache.has(k)) return undefined;
  const v = cache.get(k);
  cache.delete(k);
  cache.set(k, v);
  return v;
}
function cacheSet(k, v) {
  if (cache.has(k)) cache.delete(k);
  cache.set(k, v);
  if (cache.size > CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

// UK postcode shape: 2 rough sanity checks then let postcodes.io decide.
// We accept "SW1A 1AA", "sw1a1aa", etc. Return normalised uppercase with one
// space before the inward code, or null.
function normalise(postcode) {
  if (!postcode || typeof postcode !== 'string') return null;
  const trimmed = postcode.trim().toUpperCase().replace(/\s+/g, '');
  // Outward code is 2-4 chars, inward is always 3 chars (digit + 2 letters).
  if (trimmed.length < 5 || trimmed.length > 7) return null;
  const outward = trimmed.slice(0, -3);
  const inward = trimmed.slice(-3);
  if (!/^[A-Z]{1,2}[0-9][A-Z0-9]?$/.test(outward)) return null;
  if (!/^[0-9][A-Z]{2}$/.test(inward)) return null;
  return `${outward} ${inward}`;
}

// Resolve a postcode to { postcode, lat, lng } or null on failure.
// Never throws. Logs to console on unexpected errors.
async function lookupPostcode(postcode) {
  const key = normalise(postcode);
  if (!key) return null;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const url = `${BASE}/postcodes/${encodeURIComponent(key)}`;
  try {
    // Node 18+ has global fetch. 5s timeout so a postcodes.io hiccup can't
    // stall a profile save forever.
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 5000);
    let resp;
    try {
      resp = await fetch(url, { signal: ac.signal });
    } finally {
      clearTimeout(to);
    }
    if (!resp.ok) {
      // 404 = unknown postcode. Cache the negative result so repeated saves
      // don't keep hammering postcodes.io for the same typo.
      cacheSet(key, null);
      return null;
    }
    const body = await resp.json();
    const r = body && body.result;
    if (!r || typeof r.latitude !== 'number' || typeof r.longitude !== 'number') {
      cacheSet(key, null);
      return null;
    }
    const value = { postcode: r.postcode || key, lat: r.latitude, lng: r.longitude };
    cacheSet(key, value);
    return value;
  } catch (err) {
    console.error('[postcodes] lookup failed for', key, err && err.message);
    return null;
  }
}

module.exports = { lookupPostcode, normalise };
