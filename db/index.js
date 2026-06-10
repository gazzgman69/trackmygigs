const { Pool } = require('pg');

// SSL is required by Neon (the Postgres backing Replit Deployments) and
// rejected by Replit's internal dev Postgres ("server does not support
// SSL connections"). We detect Neon by hostname pattern AND honour an
// override flag, in case the deployment doesn't propagate NODE_ENV or
// the hostname pattern shifts. Three triggers, any of them flips SSL on:
//   1. PGHOST or DATABASE_URL contains "neon.tech" — most reliable
//      signal that we're on the Neon-backed prod DB.
//   2. NODE_ENV === 'production' — Replit Deployments usually set this.
//   3. DB_USE_SSL === '1' — manual override via Secrets.
//
// On both branches we prefer the PG* env vars over DATABASE_URL when
// PGHOST is set, so pg-connection-string does not emit the
// sslmode=require deprecation warning at boot.
const pgHost = process.env.PGHOST || '';
const pgUrl = process.env.DATABASE_URL || '';

// Replit's dev workspace exposes its internal Postgres as PGHOST='helium'
// (no SSL support). If we see that hostname, force SSL OFF regardless of
// any other signal — otherwise a globally-shared DB_USE_SSL=1 secret
// (Replit shares Secrets between workspace and deployment by default)
// would break dev.
const isInternalReplitDev = /^helium$/i.test(pgHost);

const wantSsl = !isInternalReplitDev && (
  /neon\.tech/i.test(pgHost) ||
  /neon\.tech/i.test(pgUrl) ||
  process.env.NODE_ENV === 'production' ||
  process.env.DB_USE_SSL === '1'
);

// June 2026 stress-campaign hardening. pg defaults are max 10 connections
// and an INFINITE connect wait, so under sustained load every request queued
// forever once 10 were busy and the API looked dead until a restart (seen
// during the 150-user run). Bounded waits turn that into fast 500s the
// client retry layer can handle, and statement_timeout stops a stuck query
// holding a connection hostage.
const POOL_TUNING = {
  // Default 10, not 20: Replit's internal dev Postgres has a small
  // max_connections budget, and a nodemon restart can briefly leave two
  // node processes alive. Two pools of 20 exhausted the slots and every
  // new connect hung at the 10s bound (seen 2026-06-10). Production Neon
  // can take more via PG_POOL_MAX.
  max: parseInt(process.env.PG_POOL_MAX || '10', 10),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  statement_timeout: 30000,
};

let pool;
if (process.env.PGHOST) {
  pool = new Pool({ ...POOL_TUNING, ssl: wantSsl ? { rejectUnauthorized: false } : false });
} else {
  pool = new Pool({
    ...POOL_TUNING,
    connectionString: process.env.DATABASE_URL,
    ssl: wantSsl ? { rejectUnauthorized: false } : false,
  });
}

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  end: () => pool.end(),
};
