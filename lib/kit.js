// Kit (formerly ConvertKit) integration for the TrackMyGigs owner marketing
// list. Fires once per newly-created user so the welcome series + feature
// updates + offers can run independently of any in-app notification system.
//
// Compliance posture
// ──────────────────
// Per the "consent + unsubscribe required" product call, the intent is that
// signing up for TrackMyGigs counts as an implicit opt-in for product-related
// marketing. To make that GDPR-defensible:
//   1. The sign-up screen links to the Privacy Policy which lists marketing
//      emails as a processing purpose (handled at /privacy-policy, separate).
//   2. The Kit form SHOULD be configured for double opt-in in the Kit
//      dashboard so Kit sends its own confirmation email and no one is
//      actually added to the send list until they click it. This is toggled
//      via the form settings in Kit, not the API.
//   3. Every Kit email has a one-click unsubscribe footer by default.
// The server-side hook (subscribeToKit) simply tells Kit about the signup.
// If the form is set to double opt-in, Kit handles the confirmation loop on
// its own. If it's not, the subscriber is added directly — that's Gareth's
// call to make on the Kit side.
//
// Configuration
// ─────────────
// Env vars required:
//   KIT_API_KEY   account API key from kit.com/account/api
//   KIT_FORM_ID   numeric id of the form subscribers get added to
// If either is missing, subscribeToKit() is a silent no-op — useful for
// local/dev work where we don't want to pollute the production list.
//
// Failure mode
// ────────────
// Kit is a best-effort side effect of signup. If the network or Kit itself
// is slow or down, the user still gets their account — we just log the
// failure and move on. Signup is never blocked on Kit.

const KIT_API_URL = 'https://api.convertkit.com/v3';

/**
 * Subscribe a newly-created user to the configured Kit form. Fire-and-forget:
 * callers should NOT await the returned promise if they care about signup
 * latency. Resolves with { ok: boolean, skipped?: boolean, reason?: string }.
 *
 * @param {string} email   The user's email. Required.
 * @param {string} [name]  Optional first name (Kit's `first_name` field).
 *                         Passed as-is; Kit accepts full names here too.
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, status?:number}>}
 */
async function subscribeToKit(email, name) {
  const apiKey = process.env.KIT_API_KEY;
  const formId = process.env.KIT_FORM_ID;
  if (!apiKey || !formId) {
    return { ok: false, skipped: true, reason: 'KIT_API_KEY or KIT_FORM_ID not set' };
  }
  if (!email) return { ok: false, skipped: true, reason: 'missing email' };

  const payload = { api_key: apiKey, email: String(email).trim().toLowerCase() };
  if (name) payload.first_name = String(name).trim();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${KIT_API_URL}/forms/${encodeURIComponent(formId)}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, reason: text.slice(0, 200) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) };
  }
}

module.exports = { subscribeToKit };
