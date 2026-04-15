const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const db = require('../db');

const router = express.Router();

const generateToken = () => crypto.randomBytes(32).toString('hex');

// Gmail transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

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

// Helper: find or create user by email
async function findOrCreateUser(email, name, avatarUrl, googleId) {
  let userResult = await db.query('SELECT * FROM users WHERE email = $1', [email]);

  if (userResult.rows.length === 0) {
    const createResult = await db.query(
      'INSERT INTO users (email, name, avatar_url, google_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [email, name || '', avatarUrl || null, googleId || null]
    );
    return createResult.rows[0];
  }

  const user = userResult.rows[0];

  // Update Google ID and avatar if signing in with Google for the first time
  if (googleId && !user.google_id) {
    await db.query(
      'UPDATE users SET google_id = $1, avatar_url = COALESCE($2, avatar_url), name = CASE WHEN name = \'\' THEN $3 ELSE name END WHERE id = $4',
      [googleId, avatarUrl, name, user.id]
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

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await db.query(
      'INSERT INTO magic_links (email, token, expires_at) VALUES ($1, $2, $3)',
      [email, token, expiresAt]
    );

    const magicLink = `${process.env.APP_URL}/auth/verify/${token}`;

    // Send email via Gmail
    await transporter.sendMail({
      from: `"TrackMyGigs" <${process.env.GMAIL_USER}>`,
      to: email,
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

    console.log(`Magic link sent to ${email}`);
    res.json({ success: true, message: 'Magic link sent to email' });
  } catch (error) {
    console.error('Magic link request error:', error);
    res.status(500).json({ error: 'Failed to send magic link' });
  }
});

router.get('/verify/:token', async (req, res) => {
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

    const user = await findOrCreateUser(email, '', null, null);

    await createSession(res, user.id);

    await db.query('UPDATE magic_links SET used = TRUE WHERE id = $1', [
      magicLink.id,
    ]);

    res.redirect('/');
  } catch (error) {
    console.error('Verify token error:', error);
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

// Redirect user to Google consent screen with Calendar scope
router.get('/google/calendar', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
  });
  res.redirect(authUrl);
});

// Handle the OAuth callback
router.get('/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const { id: googleId, email, name, picture } = userInfo.data;

    if (!email) return res.redirect('/?error=no_email');

    const user = await findOrCreateUser(email, name, picture, googleId);

    // Store Google tokens on user record
    await db.query(
      `UPDATE users SET
        google_access_token = $1,
        google_refresh_token = COALESCE($2, google_refresh_token),
        google_token_expires_at = $3
       WHERE id = $4`,
      [
        tokens.access_token,
        tokens.refresh_token || null,
        tokens.expiry_date ? new Date(tokens.expiry_date) : null,
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
router.get('/dev-login', async (req, res) => {
  try {
    const email = req.query.email || 'gareth@trackmygigs.app';
    const name = req.query.name || 'Gareth';
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
    const userResult = await db.query(
      'SELECT id, name, email, avatar_url, home_postcode, instruments, google_access_token FROM users WHERE id = $1',
      [session.user_id]
    );

    if (userResult.rows.length === 0) {
      return res.json({ user: null });
    }

    const user = userResult.rows[0];
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar_url: user.avatar_url,
        home_postcode: user.home_postcode,
        instruments: user.instruments,
        calendar_connected: !!user.google_access_token,
      },
    });
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
