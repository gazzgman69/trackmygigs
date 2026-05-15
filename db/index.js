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
const wantSsl = /neon\.tech/i.test(pgHost)
             || /neon\.tech/i.test(pgUrl)
             || process.env.NODE_ENV === 'production'
             || process.env.DB_USE_SSL === '1';

let pool;
if (process.env.PGHOST) {
  pool = new Pool(wantSsl ? { ssl: { rejectUnauthorized: false } } : { ssl: false });
} else {
  pool = new Pool({
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
