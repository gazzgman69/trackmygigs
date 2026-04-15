const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

const generateToken = () => crypto.randomBytes(32).toString('hex');

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
    console.log(`Magic link for ${email}: ${magicLink}`);

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
      return res.status(400).json({ error: 'Invalid or expired link' });
    }

    const magicLink = linkResult.rows[0];
    const email = magicLink.email;

    let userResult = await db.query('SELECT * FROM users WHERE email = $1', [
      email,
    ]);

    let userId;

    if (userResult.rows.length === 0) {
      const createUserResult = await db.query(
        'INSERT INTO users (email) VALUES ($1) RETURNING id',
        [email]
      );
      userId = createUserResult.rows[0].id;
    } else {
      userId = userResult.rows[0].id;
    }

    const sessionToken = generateToken();
    const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await db.query(
      'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [userId, sessionToken, sessionExpiresAt]
    );

    await db.query('UPDATE magic_links SET used = TRUE WHERE id = $1', [
      magicLink.id,
    ]);

    res.cookie('sessionToken', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.redirect('/');
  } catch (error) {
    console.error('Verify token error:', error);
    res.status(500).json({ error: 'Failed to verify token' });
  }
});

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
    const userResult = await db.query('SELECT id, name, email, avatar_url FROM users WHERE id = $1', [
      session.user_id,
    ]);

    if (userResult.rows.length === 0) {
      return res.json({ user: null });
    }

    res.json({ user: userResult.rows[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('sessionToken');
  res.json({ success: true });
});

module.exports = router;
