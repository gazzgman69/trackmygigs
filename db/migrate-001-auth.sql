-- Add google_id column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

-- Allow name to be empty (for magic link signups before profile is completed)
ALTER TABLE users ALTER COLUMN name SET DEFAULT '';
ALTER TABLE users ALTER COLUMN name DROP NOT NULL;
