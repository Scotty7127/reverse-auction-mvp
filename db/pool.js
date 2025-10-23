const { Pool } = require("pg");

// ---- Database connection ----
const isProduction = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: isProduction
    ? process.env.DATABASE_URL         // Use Neon when in production
    : process.env.LOCAL_DATABASE_URL,  // Use local DB when testing locally
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

console.log(isProduction ? "🌐 Running in production (Render/Neon)" : "💻 Running locally (localhost Postgres)");

//export module vv imp
module.exports = pool;