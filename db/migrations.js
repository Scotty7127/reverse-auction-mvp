// /db/migrations.js
const pool = require("./pool");

async function runMigrations() {
  console.log("🛠️ Running startup migrations...");
  try {
    // === ORGANISATIONS ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS organisations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        currency TEXT,
        logo_url TEXT,
        type TEXT CHECK (type IN ('client', 'agency', 'supplier')) DEFAULT 'client',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      ALTER TABLE organisations
      ADD COLUMN IF NOT EXISTS type TEXT CHECK (type IN ('client','agency','supplier')) DEFAULT 'client';
    `);
    await pool.query(`UPDATE organisations SET type='client' WHERE type IS NULL`);
    await pool.query(`
      UPDATE organisations
      SET type = LOWER(TRIM(type))
      WHERE type IS NOT NULL;
    `);
    await pool.query(`
      UPDATE organisations
      SET type='client'
      WHERE type NOT IN ('client','agency','supplier');
    `);

    // === CATEGORIES ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        organisation_id INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // === USERS ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE,
        password_hash TEXT,
        role TEXT CHECK (role IN ('manager','bidder')) DEFAULT 'bidder',
        organisation_id INT REFERENCES organisations(id) ON DELETE SET NULL,
        first_name TEXT,
        last_name TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // === EVENTS ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        title TEXT,
        description TEXT,
        organisation_id INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
        category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
        currency TEXT,
        support_contact TEXT,
        support_contact_country_code TEXT,
        support_contact_phone TEXT,
        bid_manager_name TEXT,
        bid_manager TEXT,
        bid_manager_country_code TEXT,
        bid_manager_phone TEXT,
        created_by INT REFERENCES users(id) ON DELETE SET NULL,
        auction_time TIMESTAMP,
        type VARCHAR(10) DEFAULT 'open',
        reveal_bidders BOOLEAN DEFAULT FALSE,
        auction_duration INTERVAL DEFAULT '30 minutes',
        extension_time INTERVAL DEFAULT '120 seconds',
        extension_threshold INTERVAL DEFAULT '60 seconds',
        auction_start_time TIMESTAMP,
        auction_end_time TIMESTAMP,
        is_paused BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Add new columns if they don't exist (for existing databases)
    await pool.query(`
      ALTER TABLE events
      ADD COLUMN IF NOT EXISTS support_contact_country_code TEXT,
      ADD COLUMN IF NOT EXISTS support_contact_phone TEXT,
      ADD COLUMN IF NOT EXISTS bid_manager_name TEXT,
      ADD COLUMN IF NOT EXISTS bid_manager_country_code TEXT,
      ADD COLUMN IF NOT EXISTS bid_manager_phone TEXT;
    `);

    // === INVITATIONS ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invitations (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        role TEXT CHECK (role IN ('manager','bidder')) DEFAULT 'bidder',
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        accepted BOOLEAN DEFAULT FALSE,
        organisation_id INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // === LOTS ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lots (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        title TEXT,
        description TEXT
      );
    `);

    // === LINE ITEMS ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS line_items (
        id SERIAL PRIMARY KEY,
        lot_id INT REFERENCES lots(id) ON DELETE CASCADE,
        item_number VARCHAR(50),
        item_name TEXT,
        group_number VARCHAR(50),
        description TEXT,
        quantity NUMERIC,
        uom VARCHAR(50),
        input NUMERIC,
        required BOOLEAN,
        ties TEXT,
        decimals INT,
        decrement NUMERIC,
        opening_value NUMERIC,
        baseline NUMERIC,
        ext_quantity NUMERIC,
        ext_baseline NUMERIC,
        reserve_value NUMERIC,
        incumbent VARCHAR(100),
        weighting_visible BOOLEAN,
        opening_visible BOOLEAN,
        reserve_visible BOOLEAN,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // === EVENT MEMBERS ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS event_members (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role TEXT CHECK (role IN ('creator','participant','bidder')) DEFAULT 'participant',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (event_id, user_id)
      );
    `);

    // === BIDDER ITEM ASSIGNMENTS ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bidder_item_assignments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        line_item_id INTEGER REFERENCES line_items(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, line_item_id)
      );
    `);

    // === RFQs ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rfqs (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        info TEXT,
        rich_text_content TEXT,
        publish_time TIMESTAMP,
        deadline_time TIMESTAMP,
        reminder_time TIMESTAMP,
        published BOOLEAN DEFAULT FALSE,
        published_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    // Add new columns to existing rfqs table
    await pool.query(`
      ALTER TABLE rfqs
      ADD COLUMN IF NOT EXISTS rich_text_content TEXT,
      ADD COLUMN IF NOT EXISTS published_date TIMESTAMP,
      ADD COLUMN IF NOT EXISTS clarification_deadline TIMESTAMP,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
    `);
    
    // Alter existing columns to drop NOT NULL constraints if they exist
    await pool.query(`
      ALTER TABLE rfqs
      ALTER COLUMN info DROP NOT NULL,
      ALTER COLUMN publish_time DROP NOT NULL,
      ALTER COLUMN deadline_time DROP NOT NULL;
    `).catch(() => {
      // Ignore errors if constraints don't exist
    });

    // === RFQ ATTACHMENTS ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rfq_attachments (
        id SERIAL PRIMARY KEY,
        rfq_id INTEGER REFERENCES rfqs(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER,
        mime_type TEXT,
        uploaded_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // === MESSAGES ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        read BOOLEAN DEFAULT FALSE
      );
    `);

    // === BIDS ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bids (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        line_item_id INTEGER REFERENCES line_items(id) ON DELETE CASCADE,
        amount NUMERIC(12,2) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      ALTER TABLE bids
      ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id) ON DELETE CASCADE;
    `);
    await pool.query(`
      ALTER TABLE bids
      ADD COLUMN IF NOT EXISTS line_item_id INTEGER REFERENCES line_items(id) ON DELETE CASCADE;
    `);
    await pool.query(`
      ALTER TABLE bids
      ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    `);

    // === SUPPLIER LINE ITEM SETTINGS ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS supplier_line_item_settings (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        line_item_id INTEGER REFERENCES line_items(id) ON DELETE CASCADE,
        supplier_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        weighting NUMERIC DEFAULT 1.0,
        opening_bid NUMERIC,
        effective_bid NUMERIC GENERATED ALWAYS AS (opening_bid * weighting) STORED,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (event_id, line_item_id, supplier_id)
      );
    `);

    // === RFQ RESPONSES ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rfq_responses (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        response_text TEXT,
        status TEXT CHECK (status IN ('pending','approved','rejected')) DEFAULT 'pending',
        review_notes TEXT,
        reviewed_by INTEGER REFERENCES users(id),
        reviewed_at TIMESTAMP,
        submitted_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (event_id, user_id)
      );
    `);

    // === RFQ RESPONSE ATTACHMENTS ===
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rfq_response_attachments (
        id SERIAL PRIMARY KEY,
        response_id INTEGER REFERENCES rfq_responses(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size BIGINT,
        mime_type TEXT,
        uploaded_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // === PERFORMANCE INDEXES ===
    await pool.query(`
      CREATE INDEX IF NOT EXISTS bids_event_idx ON bids(event_id);
      CREATE INDEX IF NOT EXISTS bids_event_line_idx ON bids(event_id, line_item_id);
      CREATE INDEX IF NOT EXISTS slis_event_idx ON supplier_line_item_settings(event_id);
      CREATE INDEX IF NOT EXISTS slis_event_line_idx ON supplier_line_item_settings(event_id, line_item_id);
      CREATE INDEX IF NOT EXISTS rfq_responses_event_idx ON rfq_responses(event_id);
      CREATE INDEX IF NOT EXISTS rfq_responses_status_idx ON rfq_responses(status);
    `);

    console.log("✅ Startup migrations complete.");
    console.log("✅ Performance indexes ensured.");
  } catch (err) {
    console.error("❌ Migration error:", err);
  }
}

module.exports = runMigrations;