-- Create UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20),
  instruments TEXT[],
  home_postcode VARCHAR(20),
  avatar_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  subscription_tier VARCHAR(50) DEFAULT 'free',
  premium_trial_ends TIMESTAMP,
  linked_mt_id UUID,
  linked_cf_id UUID
);

CREATE INDEX idx_users_email ON users(email);

-- Gigs table
CREATE TABLE gigs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  band_name VARCHAR(255),
  venue_name VARCHAR(255),
  venue_address TEXT,
  date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  load_in_time TIME,
  fee DECIMAL(10, 2),
  status VARCHAR(50) DEFAULT 'confirmed',
  source VARCHAR(50) DEFAULT 'manual',
  dress_code VARCHAR(255),
  notes TEXT,
  linked_crm_tenant_id UUID,
  setlist_id UUID,
  invoice_id UUID,
  mileage_miles DECIMAL(10, 2),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_gigs_user_id ON gigs(user_id);
CREATE INDEX idx_gigs_date ON gigs(date);
CREATE INDEX idx_gigs_status ON gigs(status);

-- Invoices table
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  gig_id UUID,
  band_name VARCHAR(255),
  amount DECIMAL(10, 2) NOT NULL,
  status VARCHAR(50) DEFAULT 'draft',
  invoice_number VARCHAR(50) UNIQUE,
  payment_terms VARCHAR(100),
  due_date DATE,
  sent_at TIMESTAMP,
  viewed_at TIMESTAMP,
  paid_at TIMESTAMP,
  chase_count INT DEFAULT 0,
  last_chase_at TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (gig_id) REFERENCES gigs(id) ON DELETE SET NULL
);

CREATE INDEX idx_invoices_user_id ON invoices(user_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_gig_id ON invoices(gig_id);

-- Offers table
CREATE TABLE offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL,
  recipient_id UUID NOT NULL,
  gig_id UUID NOT NULL,
  offer_type VARCHAR(50) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  fee DECIMAL(10, 2),
  deadline TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  responded_at TIMESTAMP,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (gig_id) REFERENCES gigs(id) ON DELETE CASCADE
);

CREATE INDEX idx_offers_recipient_id ON offers(recipient_id);
CREATE INDEX idx_offers_status ON offers(status);
CREATE INDEX idx_offers_created_at ON offers(created_at);

-- Contacts table
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  contact_user_id UUID,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(20),
  instruments TEXT[],
  notes TEXT,
  is_favourite BOOLEAN DEFAULT FALSE,
  gig_count INT DEFAULT 0,
  last_gig_date DATE,
  distance_miles DECIMAL(10, 2),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_contacts_owner_id ON contacts(owner_id);
CREATE INDEX idx_contacts_name ON contacts(name);

-- Threads table (for messaging)
CREATE TABLE threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gig_id UUID,
  thread_type VARCHAR(50) NOT NULL,
  participant_ids UUID[] NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (gig_id) REFERENCES gigs(id) ON DELETE CASCADE
);

CREATE INDEX idx_threads_gig_id ON threads(gig_id);

-- Messages table
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL,
  sender_id UUID NOT NULL,
  content TEXT NOT NULL,
  attachments TEXT[],
  read_by UUID[],
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_thread_id ON messages(thread_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);

-- Songs table
CREATE TABLE songs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  title VARCHAR(255) NOT NULL,
  artist VARCHAR(255),
  key VARCHAR(20),
  tempo INT,
  duration INT,
  genre VARCHAR(100),
  tags TEXT[],
  lyrics TEXT,
  chords TEXT,
  source_app VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_songs_user_id ON songs(user_id);
CREATE INDEX idx_songs_title ON songs(title);

-- Setlists table
CREATE TABLE setlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  song_ids UUID[],
  total_duration INT,
  gig_id UUID,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (gig_id) REFERENCES gigs(id) ON DELETE SET NULL
);

CREATE INDEX idx_setlists_user_id ON setlists(user_id);
CREATE INDEX idx_setlists_gig_id ON setlists(gig_id);

-- Receipts table
CREATE TABLE receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  vendor VARCHAR(255),
  amount DECIMAL(10, 2) NOT NULL,
  category VARCHAR(100),
  date DATE NOT NULL,
  photo_url TEXT,
  ai_extracted BOOLEAN DEFAULT FALSE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_receipts_user_id ON receipts(user_id);
CREATE INDEX idx_receipts_date ON receipts(date);

-- Calendar syncs table
CREATE TABLE calendar_syncs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  provider VARCHAR(50) NOT NULL,
  calendar_id VARCHAR(255),
  last_sync_at TIMESTAMP,
  sync_direction VARCHAR(50),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_calendar_syncs_user_id ON calendar_syncs(user_id);

-- Blocked dates table
CREATE TABLE blocked_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  date DATE NOT NULL,
  recurring_pattern VARCHAR(100),
  reason TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_blocked_dates_user_id ON blocked_dates(user_id);
CREATE INDEX idx_blocked_dates_date ON blocked_dates(date);

-- Sessions table
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);

-- Magic links table
CREATE TABLE magic_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_magic_links_token ON magic_links(token);
CREATE INDEX idx_magic_links_email ON magic_links(email);
