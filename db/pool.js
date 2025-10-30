const { Pool } = require("pg");

// ---- Database connection ----
const isProduction = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: isProduction
    ? process.env.DATABASE_URL         // Use Neon when in production
    : process.env.LOCAL_DATABASE_URL,  // Use local DB when testing locally
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  // Add connection pool settings
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

console.log(isProduction ? "🌐 Running in production (Render/Neon)" : "💻 Running locally (localhost Postgres)");

// Add error handler to prevent crashes
pool.on('error', (err, client) => {
  console.error('💥 Unexpected database pool error:', err.message);
});

// Test connection on startup
pool.query('SELECT NOW()').then(() => {
  console.log('✅ Database connection successful');
}).catch(err => {
  console.error('❌ Database connection failed:', err.message);
});

//export module vv imp
module.exports = pool;