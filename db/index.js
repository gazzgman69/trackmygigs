// TEMP DIAGNOSTIC: trace the source of the pg-connection-string SSL warning.
// Remove this block once the warning is silenced.
process.on('warning', (w) => {
  if (w && w.message && w.message.indexOf('SSL modes') !== -1) {
    console.error('[SSL-TRACE] PGSSLMODE =', JSON.stringify(process.env.PGSSLMODE));
    console.error('[SSL-TRACE] PGHOST    =', JSON.stringify(process.env.PGHOST));
    console.error('[SSL-TRACE] PGSSLROOTCERT =', JSON.stringify(process.env.PGSSLROOTCERT));
    console.error('[SSL-TRACE] PGSSLCERT =', JSON.stringify(process.env.PGSSLCERT));
    console.error('[SSL-TRACE] PGSSLKEY  =', JSON.stringify(process.env.PGSSLKEY));
    console.error('[SSL-TRACE] PGREQUIRESSL =', JSON.stringify(process.env.PGREQUIRESSL));
    console.error('[SSL-TRACE] DATABASE_URL set?', !!process.env.DATABASE_URL);
    console.error('[SSL-TRACE] stack:\n' + w.stack);
  }
});

// Replit's helium binding sets PGSSLMODE=require in env. pg-connection-string
// parses that on pg module init and emits a deprecation warning even if we
// pass `ssl: false` to Pool. Clear it before `pg` loads for the helium path.
if (!process.env.DATABASE_URL && process.env.PGSSLMODE) {
  delete process.env.PGSSLMODE;
}

const { Pool } = require('pg');

// Prefer DATABASE_URL if set (legacy external Neon via Secrets).
// Otherwise pg reads PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
// from env automatically, which is what Replit's integrated binding provides.
// Explicit `ssl` config in both branches silences pg-connection-string's
// SSL-mode deprecation warning at boot.
let pool;
if (process.env.DATABASE_URL) {
  // External cloud DB (Neon-style) - require SSL without strict cert validation
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
} else {
  // Replit integrated binding on internal network - SSL not required
  pool = new Pool({ ssl: false });
}

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  end: () => pool.end(),
};
