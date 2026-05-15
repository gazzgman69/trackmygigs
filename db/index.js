const { Pool } = require('pg');

// SSL is required by Neon (the Postgres backing Replit Deployments) and
// rejected by Replit's internal dev Postgres ("server does not support
// SSL connections"). We branch on NODE_ENV: Replit Deployments set it to
// 'production' automatically; the dev workspace runs without it. If your
// environment doesn't set NODE_ENV for some reason, set `DB_USE_SSL=1`
// in Secrets to force SSL on.
//
// On both branches we prefer the PG* env vars over DATABASE_URL when
// PGHOST is set, so pg-connection-string does not emit the
// sslmode=require deprecation warning at boot.
const wantSsl = process.env.NODE_ENV === 'production'
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
