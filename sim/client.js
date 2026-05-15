// Per-user HTTP client. Wraps Node's built-in fetch (Node 18+) with a
// cookie jar, a structured error logger, and a small retry helper for
// genuine transient errors (5xx, ECONNRESET, ETIMEDOUT). Every call is
// recorded to the run's events stream so the report generator can roll
// up per-endpoint counts, latencies, error samples, and timeouts.

const fs = require('fs');
const path = require('path');

class SimClient {
  constructor(opts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.userId = opts.userId || null;
    this.simIndex = opts.simIndex != null ? opts.simIndex : -1;
    this.persona = opts.persona || 'unknown';
    this.sessionToken = opts.sessionToken || null;
    this.recordEvent = opts.recordEvent; // (event) => void
    this.errorLogger = opts.errorLogger; // (errEvent) => void
    this.timeoutMs = opts.timeoutMs || 30000;
    this.retryCount = opts.retryCount != null ? opts.retryCount : 2;
  }

  // Build the standard headers for an authed request.
  headers(extra) {
    const h = { 'content-type': 'application/json' };
    if (this.sessionToken) h['cookie'] = `sessionToken=${this.sessionToken}`;
    return Object.assign(h, extra || {});
  }

  async request(method, urlPath, opts) {
    opts = opts || {};
    const url = this.baseUrl + urlPath;
    const init = {
      method,
      headers: this.headers(opts.headers),
    };
    if (opts.body != null) {
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }

    // Retry loop: only retry on genuinely transient codes/errors. Don't
    // retry 4xx (those are intentional errors we want to capture cleanly).
    let attempt = 0;
    let lastErr = null;
    while (attempt <= this.retryCount) {
      const startedAt = Date.now();
      let res, body, jsonBody, errKind = null, errMessage = null;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          res = await fetch(url, { ...init, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        // Read body up to 8KB so the error logger has detail. Trim more
        // aggressively for non-error responses to keep the events stream
        // manageable across thousands of calls.
        const text = await res.text();
        const wantsFull = res.status >= 400;
        body = wantsFull ? text.slice(0, 8000) : text.slice(0, 200);
        try { jsonBody = JSON.parse(text); } catch (_) { jsonBody = null; }
      } catch (err) {
        errKind = err.name === 'AbortError' ? 'timeout' : 'network';
        errMessage = err.message || String(err);
      }

      const elapsed = Date.now() - startedAt;
      const status = res ? res.status : 0;
      const isTransient = !res || status === 429 || (status >= 500 && status <= 599)
        || errKind === 'timeout' || errKind === 'network';
      const event = {
        ts: Date.now(),
        user_id: this.userId,
        sim_index: this.simIndex,
        persona: this.persona,
        method,
        path: urlPath,
        status,
        ok: !!(res && res.ok),
        elapsed_ms: elapsed,
        attempt,
        err_kind: errKind,
        err_message: errMessage,
        // Truncated body sample (full for errors, snippet otherwise)
        body_sample: body,
      };
      if (this.recordEvent) this.recordEvent(event);

      // Log errors more loudly so they're easy to find in the per-error file
      if (!event.ok && this.errorLogger) {
        this.errorLogger({
          ...event,
          request: { method, url: urlPath, body: opts.body },
        });
      }

      if (event.ok) return { ok: true, res, body: jsonBody, status, elapsed };
      if (isTransient && attempt < this.retryCount) {
        // Exponential backoff with jitter: 250ms, 750ms, 2s
        const wait = 250 * Math.pow(3, attempt) + Math.floor(Math.random() * 200);
        await sleep(wait);
        attempt++;
        lastErr = event;
        continue;
      }
      // Non-retryable or out of retries: return the failed event
      return { ok: false, res, body: jsonBody, status, elapsed, error: errKind || `http_${status}`, errorEvent: event };
    }
    return { ok: false, error: 'exhausted_retries', errorEvent: lastErr };
  }

  get(p, opts)    { return this.request('GET',    p, opts); }
  post(p, opts)   { return this.request('POST',   p, opts); }
  patch(p, opts)  { return this.request('PATCH',  p, opts); }
  put(p, opts)    { return this.request('PUT',    p, opts); }
  delete(p, opts) { return this.request('DELETE', p, opts); }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Append a JSONL line to the given file safely (no torn writes under
// concurrent virtual users since Node's fs.appendFile is mutex'd per fd).
function makeJsonlWriter(filepath) {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return (obj) => {
    fs.appendFileSync(filepath, JSON.stringify(obj) + '\n');
  };
}

module.exports = { SimClient, sleep, makeJsonlWriter };
