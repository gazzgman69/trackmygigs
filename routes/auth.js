const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const db = require('../db');

const router = express.Router();

const generateToken = () => crypto.randomBytes(32).toString('hex');

// ── In-memory rate limit for /auth/request (S10-01) ──────────────────────────
// Production apps would use Redis or a proper rate-limiter, but for a single
// Replit instance an LRU-ish map suffices. Keyed by ip + lowercased email;
// 3 requests per 15 minutes.
const REQUEST_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const REQUEST_LIMIT_MAX = 3;
const _requestBuckets = new Map();
function rateLimitOk(key) {
  const now = Date.now();
  const bucket = _requestBuckets.get(key) || [];
  const fresh = bucket.filter(t => now - t < REQUEST_LIMIT_WINDOW_MS);
  if (fresh.length >= REQUEST_LIMIT_MAX) {
    _requestBuckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  _requestBuckets.set(key, fresh);
  // Soft eviction: keep the Map from growing without bound.
  if (_requestBuckets.size > 10000) {
    for (const [k, v] of _requestBuckets) {
      if (v.every(t => now - t >= REQUEST_LIMIT_WINDOW_MS)) _requestBuckets.delete(k);
    }
  }
  return true;
}

// Gmail transporter — used as a fallback if RESEND_API_KEY is not configured.
// S10-07: Gmail SMTP is fine for beta but isn't a production transactional-email
// path (Gmail explicitly doesn't support this at scale, and every bounce or
// spam report lands in the owner's personal inbox). When RESEND_API_KEY is set
// we call Resend's HTTPS API instead of SMTP, which gives a real
// no-reply@trackmygigs.app envelope sender and the standard reputation tools.
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// Mail wrapper: prefer Resend over Gmail SMTP when available. Keeps the call
// sites identical (`sendEmail({ to, subject, html })`) so we don't have to
// branch per provider in every route.
async function sendEmail({ to, subject, html }) {
  if (process.env.RESEND_API_KEY) {
    const from = process.env.MAIL_FROM || 'TrackMyGigs <no-reply@trackmygigs.app>';
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Resend send failed (${resp.status}): ${body}`);
    }
    return;
  }
  // Fallback: Gmail SMTP.
  await transporter.sendMail({
    from: `"TrackMyGigs" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
  });
}

// Google OAuth client (for ID token verification)
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Google OAuth2 client (for authorization code flow with Calendar scope)
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  (process.env.APP_URL || 'https://trackmygigs.app') + '/auth/google/callback'
);

// Helper: create session and set cookie
async function createSession(res, userId) {
  const sessionToken = generateToken();
  const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db.query(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [userId, sessionToken, sessionExpiresAt]
  );

  res.cookie('sessionToken', sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  return sessionToken;
}

// S10-05: Magic-link signups arrive with name = '', which used to produce a
// user with name='' / display_name=null and a "Good morning, Guest" header on
// first load. Derive a sensible fallback from the email local-part (gareth@… →
// "Gareth") so the first-touch experience isn't literally anonymous. Users
// can overwrite this later from Settings or as part of the new onboarding
// form (S10-06).
function deriveNameFromEmail(email) {
  if (!email) return '';
  const local = String(email).split('@')[0] || '';
  if (!local) return '';
  // Replace separators with spaces then title-case each token.
  return local
    .replace(/[._-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Helper: find or create user by email
async function findOrCreateUser(email, name, avatarUrl, googleId) {
  let userResult = await db.query('SELECT * FROM users WHERE email = $1', [email]);

  if (userResult.rows.length === 0) {
    // On creation, seed display_name with the provided name (typically the user's real name from Google)
    // name stays in sync for back-compat, but users can later edit name to be an act/band name.
    // S10-05: when no name is provided (magic-link flow), derive from email.
    const derivedName = name || deriveNameFromEmail(email);
    const createResult = await db.query(
      'INSERT INTO users (email, name, display_name, avatar_url, google_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [email, derivedName, derivedName || null, avatarUrl || null, googleId || null]
    );
    return createResult.rows[0];
  }

  const user = userResult.rows[0];

  // Update Google ID and avatar if signing in with Google for the first time.
  // Always populate display_name from Google if missing (their real name).
  // Only overwrite "name" if it's still empty (preserves user-chosen act/band names).
  if (googleId && !user.google_id) {
    await db.query(
      `UPDATE users SET
        google_id = $1,
        avatar_url = COALESCE($2, avatar_url),
        name = CASE WHEN name = '' THEN $3 ELSE name END,
        display_name = COALESCE(display_name, $3)
       WHERE id = $4`,
      [googleId, avatarUrl, name, user.id]
    );
  } else if (name && !user.display_name) {
    // Backfill display_name for existing users signing in with Google
    await db.query(
      'UPDATE users SET display_name = $1 WHERE id = $2 AND display_name IS NULL',
      [name, user.id]
    );
  }

  return user;
}

// ---- MAGIC LINK AUTH ----

router.post('/request', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    // Basic email sanity so bots can't pollute the bucket with garbage values.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    // S10-01: rate-limit per ip + email to prevent abuse / mail-bombing.
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const key = `${ip}|${normalizedEmail}`;
    if (!rateLimitOk(key)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await db.query(
      'INSERT INTO magic_links (email, token, expires_at) VALUES ($1, $2, $3)',
      [normalizedEmail, token, expiresAt]
    );

    const magicLink = `${process.env.APP_URL}/auth/verify/${token}`;

    // S10-07: goes through sendEmail(), which prefers Resend over Gmail SMTP
    // when RESEND_API_KEY is configured. Keeping the HTML body identical so
    // we don't re-test rendering across providers.
    await sendEmail({
      to: normalizedEmail,
      subject: 'Your TrackMyGigs sign-in link',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <div style="font-size: 48px; margin-bottom: 8px;">🎵</div>
            <h1 style="font-size: 24px; color: #0D1117; margin: 0;">TrackMyGigs</h1>
          </div>
          <p style="font-size: 16px; color: #333; line-height: 1.5;">
            Click the button below to sign in to your account. This link expires in 15 minutes.
          </p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${magicLink}" style="display: inline-block; background: #F0A500; color: #0D1117; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">
              Sign in to TrackMyGigs
            </a>
          </div>
          <p style="font-size: 13px; color: #888; line-height: 1.4;">
            If you didn't request this link, you can safely ignore this email.
          </p>
        </div>
      `,
    });

    console.log(`Magic link sent to ${normalizedEmail}`);
    res.json({ success: true, message: 'Magic link sent to email' });
  } catch (error) {
    console.error('Magic link request error:', error);
    res.status(500).json({ error: 'Failed to send magic link' });
  }
});

// S10-02: splitting verify into GET (landing page only, does NOT consume the
// token) and POST (consumes + signs in). Email-preview scanners like
// Microsoft Defender for 365 prefetch every link in an incoming email; with
// the old GET-only flow a scanner would burn the magic link before the user
// ever clicked. The scanner's GET now lands on a harmless confirmation page,
// and the real sign-in only happens when the human presses the button, which
// POSTs back to the same token.
router.get('/verify/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const linkResult = await db.query(
      'SELECT email, expires_at, used FROM magic_links WHERE token = $1',
      [token]
    );
    if (linkResult.rows.length === 0) {
      return res.redirect('/?error=invalid_link');
    }
    const link = linkResult.rows[0];
    if (link.used || new Date(link.expires_at) < new Date()) {
      return res.redirect('/?error=invalid_link');
    }
    const emailEsc = String(link.email || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    res.set('Content-Type', 'text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Sign in to TrackMyGigs</title>
  <style>
    :root { --bg:#0D1117; --card:#161B22; --border:#30363D; --text:#F0F6FC; --text-2:#8B949E; --accent:#F0A500; }
    *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
    body{background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
    .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:32px 24px;max-width:420px;width:100%;text-align:center;}
    h1{font-size:22px;margin-bottom:6px;}
    p{color:var(--text-2);font-size:14px;line-height:1.5;margin-bottom:20px;}
    .email{color:var(--text);font-weight:600;word-break:break-all;}
    button{display:block;width:100%;background:var(--accent);color:#0D1117;border:0;border-radius:8px;padding:14px 16px;font-size:15px;font-weight:700;cursor:pointer;}
    .logo{font-size:40px;margin-bottom:8px;}
  </style>
</head>
<body>
  <form class="card" method="POST" action="/auth/verify/${encodeURIComponent(token)}">
    <div class="logo">&#x1F3B5;</div>
    <h1>Sign in to TrackMyGigs</h1>
    <p>You're about to sign in as<br><span class="email">${emailEsc}</span></p>
    <button type="submit">Sign me in</button>
  </form>
</body>
</html>`);
  } catch (error) {
    console.error('Verify GET error:', error);
    res.redirect('/?error=verification_failed');
  }
});

router.post('/verify/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const linkResult = await db.query(
      'SELECT * FROM magic_links WHERE token = $1 AND expires_at > NOW() AND used = FALSE',
      [token]
    );

    if (linkResult.rows.length === 0) {
      return res.redirect('/?error=invalid_link');
    }

    const magicLink = linkResult.rows[0];
    const email = magicLink.email;

    // S10-05: findOrCreateUser now derives a name from the email local-part
    // when none is passed, so first-load won't say "Good morning, Guest".
    const user = await findOrCreateUser(email, '', null, null);

    await createSession(res, user.id);

    await db.query('UPDATE magic_links SET used = TRUE WHERE id = $1', [
      magicLink.id,
    ]);

    res.redirect('/');
  } catch (error) {
    console.error('Verify POST error:', error);
    res.redirect('/?error=verification_failed');
  }
});

// ---- GOOGLE OAUTH ----

router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Google credential is required' });
    }

    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    if (!email) {
      return res.status(400).json({ error: 'Email not provided by Google' });
    }

    const user = await findOrCreateUser(email, name, picture, googleId);

    await createSession(res, user.id);

    res.json({ success: true, user: { id: user.id, name: user.name || name, email: user.email, avatar_url: user.avatar_url || picture } });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ error: 'Google authentication failed' });
  }
});

// ---- GOOGLE CALENDAR OAUTH (Authorization Code Flow) ----

// Resolve the currently logged-in user from the session cookie, or null.
// Used by /google/callback to distinguish "link calendar to existing account"
// from "sign in with Google". authMiddleware isn't mounted on /auth/* routes
// (they must be reachable pre-login), so we resolve the session inline here.
async function resolveSessionUser(req) {
  const token = req.cookies && req.cookies.sessionToken;
  if (!token) return null;
  try {
    const result = await db.query(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('resolveSessionUser error:', err);
    return null;
  }
}

// Redirect user to Google consent screen with Calendar scope.
// Scopes:
//   calendar.events           - read/write events (two-way sync)
//   calendar.calendarlist.readonly - let user pick which calendar to sync
router.get('/google/calendar', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    ],
  });
  res.redirect(authUrl);
});

// Handle the OAuth callback. Two modes:
//   (1) Link mode: user is already logged in (valid session cookie). We attach
//       the Google Calendar tokens to their existing user record and preserve
//       their session. The Google account they authenticated with can be
//       different from their app login email. That's intentional (e.g. a
//       musician whose band-admin Google account holds the shared calendar).
//   (2) Sign-in mode: no valid session. This OAuth acts as identity. We
//       find-or-create the user by Google email and start a session.
router.get('/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const currentUser = await resolveSessionUser(req);

    if (currentUser) {
      // Link mode: attach tokens to the current user, leave session alone.
      // Fetch userinfo so we can remember WHICH Google account is linked
      // (the calendar's Google email can be different from the app login).
      let linkEmail = null;
      try {
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        linkEmail = userInfo.data && userInfo.data.email ? userInfo.data.email : null;
      } catch (e) {
        console.warn('[oauth] link-mode userinfo fetch failed:', e.message);
      }
      await db.query(
        `UPDATE users SET
          google_access_token = $1,
          google_refresh_token = COALESCE($2, google_refresh_token),
          google_token_expires_at = $3,
          google_calendar_email = COALESCE($4, google_calendar_email),
          google_connection_state = NULL,
          google_connection_error = NULL
         WHERE id = $5`,
        [
          tokens.access_token,
          tokens.refresh_token || null,
          tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          linkEmail,
          currentUser.id,
        ]
      );
      return res.redirect('/?calendar_connected=true');
    }

    // Sign-in mode: no existing session, treat as identity.
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const { id: googleId, email, name, picture } = userInfo.data;

    if (!email) return res.redirect('/?error=no_email');

    const user = await findOrCreateUser(email, name, picture, googleId);

    await db.query(
      `UPDATE users SET
        google_access_token = $1,
        google_refresh_token = COALESCE($2, google_refresh_token),
        google_token_expires_at = $3,
        google_calendar_email = COALESCE($4, google_calendar_email),
        google_connection_state = NULL,
        google_connection_error = NULL
       WHERE id = $5`,
      [
        tokens.access_token,
        tokens.refresh_token || null,
        tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        email || null,
        user.id,
      ]
    );

    await createSession(res, user.id);
    res.redirect('/?calendar_connected=true');
  } catch (error) {
    console.error('Google Calendar OAuth error:', error);
    res.redirect('/?error=calendar_auth_failed');
  }
});

// Helper: get a working Google auth client for a user (refreshes if needed)
async function getGoogleAuthForUser(userId) {
  const result = await db.query(
    'SELECT google_access_token, google_refresh_token, google_token_expires_at FROM users WHERE id = $1',
    [userId]
  );
  const user = result.rows[0];
  if (!user || !user.google_access_token) return null;

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    (process.env.APP_URL || 'https://trackmygigs.app') + '/auth/google/callback'
  );

  client.setCredentials({
    access_token: user.google_access_token,
    refresh_token: user.google_refresh_token,
    expiry_date: user.google_token_expires_at ? new Date(user.google_token_expires_at).getTime() : null,
  });

  // If token is expired, refresh it
  if (user.google_token_expires_at && new Date(user.google_token_expires_at) < new Date()) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      // Update stored tokens
      await db.query(
        'UPDATE users SET google_access_token = $1, google_token_expires_at = $2 WHERE id = $3',
        [credentials.access_token, credentials.expiry_date ? new Date(credentials.expiry_date) : null, userId]
      );
    } catch (err) {
      console.error('Token refresh failed:', err);
      return null;
    }
  }

  return client;
}

// Export helper for use in API routes
router.getGoogleAuthForUser = getGoogleAuthForUser;

// ---- DEV LOGIN (for testing without email/Google) ----
// S10-03: Gate dev-login. To disable in production, set DISABLE_DEV_LOGIN=true
// in the environment. Also enforces an allow-list of emails when ALLOW_DEV_LOGIN_EMAILS
// is set (comma-separated). This means an attacker with knowledge of the route
// can't enumerate / create arbitrary accounts at will.
router.get('/dev-login', async (req, res) => {
  if (process.env.DISABLE_DEV_LOGIN === 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const email = String(req.query.email || 'gareth@trackmygigs.app').trim().toLowerCase();
    const name = req.query.name || 'Gareth';

    // Optional allow-list to stop random email injection through this route.
    const allowList = (process.env.ALLOW_DEV_LOGIN_EMAILS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (allowList.length > 0 && !allowList.includes(email)) {
      return res.status(403).json({ error: 'Dev login not allowed for this email' });
    }

    const user = await findOrCreateUser(email, name, null, null);
    await createSession(res, user.id);
    res.redirect('/');
  } catch (error) {
    console.error('Dev login error:', error);
    res.status(500).json({ error: 'Dev login failed' });
  }
});

// ---- SESSION ----

router.get('/me', async (req, res) => {
  try {
    const token = req.cookies.sessionToken;

    if (!token) {
      return res.json({ user: null });
    }

    const result = await db.query(
      'SELECT * FROM sessions WHERE token = $1 AND expires_at > NOW()',
      [token]
    );

    if (result.rows.length === 0) {
      return res.json({ user: null });
    }

    const session = result.rows[0];
    // S10-04: return the full user profile (minus secret fields) so the app
    // doesn't also have to fetch /api/user/profile to bootstrap. The old
    // 9-field response forced two round-trips and opened a race where
    // window._currentUser and window._cachedProfile could disagree until
    // prefetchAllData() completed.
    const userResult = await db.query(
      `SELECT id, name, display_name, email, avatar_url, home_postcode, postcode,
              instruments, public_slug, onboarded_at,
              text_scale, colour_theme, invoice_prefix,
              invoice_next_number, invoice_due_days, invoice_footer,
              business_name, business_address, business_phone, vat_number,
              bank_account_name, bank_sort_code, bank_account_number,
              rate_standard, rate_premium, rate_dep, rate_deposit_pct, rate_notes,
              epk_bio, epk_photo_url, epk_video_url, epk_audio_url,
              available_for_deps, created_at, updated_at,
              google_calendar_email AS calendar_email,
              (google_access_token IS NOT NULL) AS calendar_connected
         FROM users WHERE id = $1`,
      [session.user_id]
    ).catch(async () => {
      // Some columns may not exist on older databases; fall back to SELECT *.
      return await db.query('SELECT * FROM users WHERE id = $1', [session.user_id]);
    });

    if (userResult.rows.length === 0) {
      return res.json({ user: null });
    }

    const u = userResult.rows[0];
    // Strip secret fields before returning. Only drop them if present.
    const SECRET_FIELDS = ['google_access_token', 'google_refresh_token', 'google_token_expires_at'];
    const safe = { ...u };
    for (const f of SECRET_FIELDS) delete safe[f];
    if (!('calendar_connected' in safe)) safe.calendar_connected = !!u.google_access_token;
    res.json({ user: safe });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const token = req.cookies.sessionToken;
    if (token) {
      await db.query('DELETE FROM sessions WHERE token = $1', [token]);
    }
    res.clearCookie('sessionToken');
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.clearCookie('sessionToken');
    res.json({ success: true });
  }
});

module.exports = router;
