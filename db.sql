CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT CHECK (role IN ('buyer','supplier')) NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  organisation TEXT,
  currency TEXT,
  support_contact TEXT,
  bid_manager TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE lots (
  id SERIAL PRIMARY KEY,
  event_id INT REFERENCES events(id),
  title TEXT NOT NULL
);

CREATE TABLE bids (
  id SERIAL PRIMARY KEY,
  lot_id INT REFERENCES lots(id),
  supplier_id INT REFERENCES users(id),
  supplier_name TEXT,
  amount NUMERIC NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);