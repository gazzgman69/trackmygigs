// ── Shared Anthropic (Claude Haiku 4.5) helper ───────────────────────────────
// One module, one initialised client, used by every AI feature in the app.
// Extracted from routes/calendar.js so the AI extras (smart paste, receipt
// OCR, invoice chase drafter, set list generator, bio writer, insight
// narratives, sanity checks, ChordPro normaliser) share the same proxy
// resolution and JSON parsing logic.

let _client = null;
let _disabled = false;
let _source = null; // 'replit' | 'direct' | null

// Replit's AI integration proxy is preferred when present: the app calls
// Claude without the app owner managing a key or billing, because Replit
// handles auth behind the proxy and bills the Replit account. If the proxy
// env vars aren't set, fall back to a direct ANTHROPIC_API_KEY. If neither
// exists, AI is disabled and every feature caller should fall back to a
// deterministic path or return a graceful error.
function resolveConfig() {
  const replitBaseUrl = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const replitApiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  if (replitBaseUrl && replitApiKey) {
    return { source: 'replit', config: { apiKey: replitApiKey, baseURL: replitBaseUrl } };
  }
  const directKey = process.env.ANTHROPIC_API_KEY;
  if (directKey) {
    return { source: 'direct', config: { apiKey: directKey } };
  }
  return null;
}

function getClient() {
  if (_client) return _client;
  if (_disabled) return null;
  const resolved = resolveConfig();
  if (!resolved) {
    _disabled = true;
    return null;
  }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic(resolved.config);
    _source = resolved.source;
    console.log(`[ai] Anthropic enabled via ${resolved.source} path`);
    return _client;
  } catch (e) {
    console.error('[ai] Failed to init Anthropic SDK:', e.message || e);
    _disabled = true;
    return null;
  }
}

function getSource() {
  if (_source) return _source;
  if (_disabled) return null;
  const resolved = resolveConfig();
  return resolved ? resolved.source : null;
}

function isEnabled() {
  return !!getClient();
}

// Strip a JSON value out of a model response. Haiku is reliable about pure
// JSON when the prompt says so, but it occasionally wraps output in a
// ```json code fence. Handle both.
function extractJSON(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch (e) {
    // Last-resort: find the first { or [ and try to parse from there.
    const firstBrace = t.search(/[{\[]/);
    if (firstBrace > 0) {
      try {
        return JSON.parse(t.slice(firstBrace));
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

// Main helper. Pass system prompt, user content (string OR array of content
// blocks for multimodal calls), optional max_tokens. Returns parsed JSON when
// `json: true`, raw text otherwise. Returns null on any failure so callers
// can decide how to degrade.
//
// Usage:
//   const data = await callHaiku({
//     system: 'You are ...',
//     user: 'Extract ...',
//     json: true,
//     maxTokens: 1024,
//   });
//
// Multimodal (image + text):
//   const data = await callHaiku({
//     system: '...',
//     user: [
//       { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
//       { type: 'text', text: 'Extract the receipt fields as JSON.' },
//     ],
//     json: true,
//   });
async function callHaiku({ system, user, json = false, maxTokens = 1024, model = 'claude-haiku-4-5' }) {
  const client = getClient();
  if (!client) return null;

  const messages = [
    {
      role: 'user',
      content: typeof user === 'string' ? user : user,
    },
  ];

  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages,
    });
    const text = response.content?.[0]?.text || '';
    if (!json) return text;
    return extractJSON(text);
  } catch (err) {
    console.error('[ai] callHaiku failed:', err.message || err);
    return null;
  }
}

module.exports = {
  callHaiku,
  isEnabled,
  getSource,
  extractJSON,
};
