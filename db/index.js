const { Pool } = require('pg');

// Replit auto-exports both DATABASE_URL (with sslmode=require) and the PG*
// env vars. We prefer PG* when PGHOST is set so pg-connection-string does
// not emit the deprecation warning for the sslmode=require URL param.
//
// SSL: Replit Deployments use Neon-backed Postgres for production, and
// Neon refuses connections that arrive without TLS ("connection is
// insecure"). Setting ssl: { rejectUnauthorized: false } makes the client
// negotiate TLS without strict certificate validation, which is what
// Neon expects from the connection-pooler endpoint. Applies on both
// branches: PG* env path AND connectionString path.
let pool;
if (process.env.PGHOST) {
  pool = new Pool({ ssl: { rejectUnauthorized: false } });
} else {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
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
