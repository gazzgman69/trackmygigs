// Retry-with-backoff helper for Google API calls.
//
// Google's APIs throttle on per-user quotas (Sheets at ~60 req/min, Calendar
// at higher but still rate-limited), and any of the bulk-read endpoints we
// hit (events.list, spreadsheets.values.get) can return 429 or 503 under
// load. Without a retry, a single transient blip fails the user's whole
// sync. This wrapper retries with exponential backoff + jitter on the codes
// Google's own docs say to retry, and re-throws unchanged on anything else.
//
// Usage:
//   const { withGoogleRetry } = require('../lib/google-retry');
//   const resp = await withGoogleRetry(() => calendar.events.list({...}));

function statusOf(err) {
  if (!err) return 0;
  return err.code
    || err.status
    || (err.response && err.response.status)
    || 0;
}

function isRetryable(err) {
  const code = statusOf(err);
  if (code === 429) return true;
  if (code >= 500 && code <= 599) return true;
  // Network-level transients
  const msg = err && err.message ? String(err.message) : '';
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|socket hang up/i.test(msg)) return true;
  return false;
}

async function withGoogleRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts || 4;
  const baseDelay = opts.baseDelay || 400; // ms
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts) throw err;
      // Exponential backoff with jitter: ~400ms, ~800ms, ~1600ms (with up to
      // 30% random jitter to avoid thundering herd from a coordinated rate-
      // limit window expiring at the same millisecond for everyone).
      const jitter = 1 + Math.random() * 0.3;
      const delay = Math.round(baseDelay * Math.pow(2, attempt - 1) * jitter);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { withGoogleRetry, isRetryable, statusOf };
