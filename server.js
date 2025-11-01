// Load environment variables from .env file in development
// In production (Render), environment variables are set directly and .env doesn't exist
require("dotenv").config({ path: '.env' });

console.log("🔍 Environment check on startup:");
console.log("  - NODE_ENV:", process.env.NODE_ENV);
console.log("  - APP_URL:", process.env.APP_URL);
console.log("  - RENDER_EXTERNAL_URL:", process.env.RENDER_EXTERNAL_URL);

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const pool = require("./db/pool");
const runMigrations = require("./db/migrations");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const open = require("open").default;
const { ensureAuthenticated } = require("./middleware/auth");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "client")));

// Disable caching for all responses (development safety)
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

// ---- Route mounting (Express Router pattern) ----
const authRoutes = require("./routes/route-auth")(pool);
app.use("/", authRoutes);

const messageRoutes = require("./routes/route-messages")(io);
app.use("/", messageRoutes);

const eventRoutes = require("./routes/route-events")(io);
app.use("/", eventRoutes);

const organisationRoutes = require("./routes/route-organisations")(pool);
app.use("/", organisationRoutes);

const lotRoutes = require("./routes/route-lots")(pool);
app.use("/", lotRoutes);

const categoryRoutes = require("./routes/route-categories")(pool);
app.use("/", categoryRoutes);

const rfqRoutes = require("./routes/route-rfqs")(pool);
app.use("/", rfqRoutes);

const responseRoutes = require("./routes/route-responses")(pool);
app.use("/", responseRoutes);

const adminRoutes = require("./routes/route-admin")(pool);
app.use("/", adminRoutes);

const userRoutes = require("./routes/route-users")(pool);
app.use("/", userRoutes);

const invitationRoutes = require("./routes/route-invitations")(pool);
app.use("/", invitationRoutes);

const statsRoutes = require("./routes/route-stats")(pool);
app.use("/", statsRoutes);

const staticRoutes = require("./routes/route-static")();
app.use("/", staticRoutes);

// ---- Migrations: run automatically on startup ----
async function connectWithRetry(maxRetries = 5, delayMs = 3000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const client = await pool.connect();
      console.log("✅ Database connected successfully");
      client.release();
      return true;
    } catch (err) {
      console.log(`⏳ Database connection attempt ${i + 1}/${maxRetries} failed: ${err.message}`);
      if (i < maxRetries - 1) {
        console.log(`   Retrying in ${delayMs/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  console.error("❌ Database connection failed after all retries");
  return false;
}

(async () => {
  const connected = await connectWithRetry();
  if (connected) {
    try {
      await runMigrations();
      console.log("✅ Migrations completed");
    } catch (err) {
      console.error("❌ Migration failed:", err.message);
    }
  } else {
    console.warn("⚠️ Starting server without database connection");
  }
})();

// ---- Socket.IO Setup ----
require("./sockets/socket-messaging")(io);
const auctionTimer = require("./sockets/socket-auction-timer")(io);

// Make timer available globally for routes to use
global.auctionTimer = auctionTimer;

// ---- Start server ----
server.listen(4000, () => {
  const url = "http://localhost:4000/start.html";
  if (process.env.NODE_ENV !== "production") {
    console.log(`✅ Local server running on ${url}`);
    open(url).catch(err => console.error("Could not open browser:", err));
  } else {
    console.log("🌐 Server running in production (Render)");
  }
});