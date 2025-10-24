require("dotenv").config();
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

// Set up multer for file uploads
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const filename = file.fieldname + "-" + Date.now() + ext;
    cb(null, filename);
  },
});

const upload = multer({ storage });
require("./routes/route-auth")(app, pool);

const messageRoutes = require("./routes/route-messages")(io);
app.use("/", messageRoutes);



// ---- Migrations: run automatically on startup ----
(async () => {
  try {
    await pool.connect();
    console.log("✅ Database connected successfully");
    await runMigrations();
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
  }
})();

// ---- User Authentication ----
const SECRET = "supersecret"; // You can change this to a stronger secret in production



// === Submit a new bid ===
app.post("/events/:id/bids", ensureAuthenticated, async (req, res) => {
  try {
    const { amount, line_item_id } = req.body;
    const eventId = req.params.id;
    const userId = req.user.id;

    if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: "Invalid bid amount" });
    }

    const result = await pool.query(
      `INSERT INTO bids (event_id, user_id, line_item_id, amount)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [eventId, userId, line_item_id || null, amount]
    );

    const bid = result.rows[0];
    const ures = await pool.query(
      'SELECT first_name, last_name, email FROM users WHERE id=$1',
      [userId]
    );
    const u = ures.rows[0] || {};
    const display_name = `${(u.first_name || '').trim()} ${(u.last_name || '').trim()}`.trim() || u.email || `User ${userId}`;
    const enriched = { ...bid, display_name };
    io.to(`event_${eventId}`).emit("bid_update", enriched);
    res.json(enriched);
  } catch (err) {
    console.error("Error submitting bid:", err);
    res.status(500).json({ error: "Failed to submit bid" });
  }
});

// === Bulk Bid Submission ===
app.post("/events/:id/bids/bulk", ensureAuthenticated, async (req, res) => {
  try {
    const eventId = req.params.id;
    const userId = req.user.id;
    const { bids } = req.body;

    if (!Array.isArray(bids) || bids.length === 0) {
      return res.status(400).json({ error: "No bids provided" });
    }

    const ures = await pool.query(
      'SELECT first_name, last_name, email FROM users WHERE id=$1',
      [userId]
    );
    const u = ures.rows[0] || {};
    const display_name = `${(u.first_name || '').trim()} ${(u.last_name || '').trim()}`.trim() || u.email || `User ${userId}`;

    const insertedBids = [];
    for (const bid of bids) {
      const { line_item_id, amount } = bid;
      if (!line_item_id || isNaN(amount)) continue;

      const result = await pool.query(
        `INSERT INTO bids (event_id, user_id, line_item_id, amount)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [eventId, userId, line_item_id, amount]
      );
      const enriched = { ...result.rows[0], display_name };
      insertedBids.push(enriched);

      // Broadcast each bid update in real-time
      io.to(`event_${eventId}`).emit("bid_update", enriched);
    }

    res.json({ success: true, inserted: insertedBids.length });
  } catch (err) {
    console.error("Error submitting bulk bids:", err);
    res.status(500).json({ error: "Failed to submit bulk bids" });
  }
});

// === Pause Auction ===
app.patch("/events/:id/pause", ensureAuthenticated, async (req, res) => {
  if (req.user.role !== "manager") return res.status(403).json({ error: "Only managers can pause auctions" });
  await pool.query("UPDATE events SET type = 'paused' WHERE id=$1", [req.params.id]);
  io.to(`event_${req.params.id}`).emit("auction_paused");
  res.json({ success: true });
});

// === Resume Auction ===
app.patch("/events/:id/resume", ensureAuthenticated, async (req, res) => {
  if (req.user.role !== "manager") return res.status(403).json({ error: "Only managers can resume auctions" });
  await pool.query("UPDATE events SET type = 'open' WHERE id=$1", [req.params.id]);
  io.to(`event_${req.params.id}`).emit("auction_resumed");
  res.json({ success: true });
});

// ---- Events Management ----

// Helper to normalize interval fields (returns interval string for Postgres)
function normalizeInterval(value, unit) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  let num = Number(value);
  if (isNaN(num) || num <= 0) return null;
  // Round to integer seconds/minutes for safety
  num = Math.round(num);
  return `${num} ${unit}`;
}

// Create new event (store created_by as authenticated user)
app.post("/events", ensureAuthenticated, async (req, res) => {
  try {
    const { title, description, organisation_id, category_id, currency, support_contact, bid_manager, auction_time, type, auction_duration, extension_time, extension_threshold } = req.body;
    const created_by = req.user.id;
    // Use normalizeInterval helper for interval fields
    const auctionDurationInterval = normalizeInterval(auction_duration, "minutes");
    const extensionTimeInterval = normalizeInterval(extension_time, "seconds");
    const extensionThresholdInterval = normalizeInterval(extension_threshold, "seconds");
    const result = await pool.query(
      `INSERT INTO events (title, description, organisation_id, category_id, currency, support_contact, bid_manager, created_by, auction_time, type, auction_duration, extension_time, extension_threshold)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        title,
        description,
        organisation_id,
        category_id,
        currency,
        support_contact,
        bid_manager,
        created_by,
        auction_time,
        type || 'open',
        auctionDurationInterval,
        extensionTimeInterval,
        extensionThresholdInterval
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error creating event:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get all events (protected)
app.get("/events", ensureAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*, 
             o.name AS organisation_name, 
             c.name AS category_name,
             ROUND(EXTRACT(EPOCH FROM e.auction_duration) / 60)::int AS auction_duration,
             ROUND(EXTRACT(EPOCH FROM e.extension_time))::int AS extension_time,
             ROUND(EXTRACT(EPOCH FROM e.extension_threshold))::int AS extension_threshold
      FROM events e
      LEFT JOIN organisations o ON e.organisation_id = o.id
      LEFT JOIN categories c ON e.category_id = c.id
      ORDER BY e.auction_time ASC NULLS LAST, e.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching events:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get a single event by ID (with line items and supplier assignments)
app.get("/events/:id", async (req, res) => {
  try {
    const eventResult = await pool.query(`
      SELECT e.*, 
             o.name AS organisation_name, 
             c.name AS category_name,
             ROUND(EXTRACT(EPOCH FROM e.auction_duration) / 60)::int AS auction_duration,
             ROUND(EXTRACT(EPOCH FROM e.extension_time))::int AS extension_time,
             ROUND(EXTRACT(EPOCH FROM e.extension_threshold))::int AS extension_threshold
      FROM events e
      LEFT JOIN organisations o ON e.organisation_id = o.id
      LEFT JOIN categories c ON e.category_id = c.id
      WHERE e.id = $1
    `, [req.params.id]);

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: "Event not found" });
    }
    const event = eventResult.rows[0];

    // Include all line items for this event
    const lineItems = await pool.query(`
      SELECT li.*, l.title AS lot_title
      FROM line_items li
      JOIN lots l ON li.lot_id = l.id
      WHERE l.event_id = $1
      ORDER BY l.id ASC, li.id ASC
    `, [req.params.id]);
    event.line_items = lineItems.rows;

    // Include all supplier assignments for this event
    const supplierAssignments = await pool.query(`
      SELECT 
        s.event_id,
        s.line_item_id,
        s.supplier_id,
        COALESCE(s.weighting, 1.0) AS weighting,
        s.opening_bid,
        (u.first_name || ' ' || u.last_name) AS supplier_name,
        u.email AS supplier_email
      FROM supplier_line_item_settings s
      JOIN users u ON u.id = s.supplier_id
      WHERE s.event_id = $1
      ORDER BY supplier_name ASC, s.line_item_id ASC
    `, [req.params.id]);
    event.supplier_assignments = supplierAssignments.rows;

    res.json(event);
  } catch (err) {
    console.error("Error fetching event:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get all supplier assignments for an event (opening bids + weighting, by line item)
app.get("/events/:id/supplier-assignments", ensureAuthenticated, async (req, res) => {
  try {
    const eventId = req.params.id;
    const result = await pool.query(`
      SELECT 
        s.event_id,
        s.line_item_id,
        s.supplier_id,
        COALESCE(s.weighting, 1.0) AS weighting,
        s.opening_bid,
        (u.first_name || ' ' || u.last_name) AS supplier_name,
        u.email AS supplier_email
      FROM supplier_line_item_settings s
      JOIN users u ON u.id = s.supplier_id
      WHERE s.event_id = $1
      ORDER BY supplier_name ASC, s.line_item_id ASC
    `, [eventId]);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching event supplier assignments:", err);
    res.status(500).json({ error: "Failed to fetch supplier assignments" });
  }
});

// Update an event by ID
app.put("/events/:id", async (req, res) => {
  try {
    const { title, description, organisation_id, category_id, currency, support_contact, bid_manager, auction_time, type, auction_duration, extension_time, extension_threshold } = req.body;
    // Use normalizeInterval helper for interval fields
    const auctionDurationInterval = normalizeInterval(auction_duration, "minutes");
    const extensionTimeInterval = normalizeInterval(extension_time, "seconds");
    const extensionThresholdInterval = normalizeInterval(extension_threshold, "seconds");
    const result = await pool.query(
      `UPDATE events
       SET title=$1, description=$2, organisation_id=$3, category_id=$4, currency=$5, support_contact=$6, bid_manager=$7, auction_time=$8, type=$9, auction_duration=$10, extension_time=$11, extension_threshold=$12
       WHERE id=$13
       RETURNING *`,
      [
        title,
        description,
        organisation_id,
        category_id,
        currency,
        support_contact,
        bid_manager,
        auction_time,
        type || 'open',
        auctionDurationInterval,
        extensionTimeInterval,
        extensionThresholdInterval,
        req.params.id
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Event not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating event:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete an event by ID
app.delete("/events/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM events WHERE id = $1 RETURNING *", [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Event not found" });
    }
    res.json({ success: true, message: "Event deleted" });
  } catch (err) {
    console.error("Error deleting event:", err);
    res.status(500).json({ error: err.message });
  }
});


// === Assign or Remove Users from Events ===

// Get all members for an event
app.get("/events/:id/members", ensureAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT em.*, u.first_name, u.last_name, u.email, u.role AS user_role
      FROM event_members em
      JOIN users u ON em.user_id = u.id
      WHERE em.event_id = $1
      ORDER BY u.first_name ASC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching event members:", err);
    res.status(500).json({ error: "Failed to fetch members" });
  }
});

// Add user to event
app.post("/events/:id/members", ensureAuthenticated, async (req, res) => {
  try {
    const { user_id, role } = req.body;
    const result = await pool.query(`
      INSERT INTO event_members (event_id, user_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (event_id, user_id) DO NOTHING
      RETURNING *;
    `, [req.params.id, user_id, role || 'participant']);
    res.json(result.rows[0] || { message: "User already assigned" });
  } catch (err) {
    console.error("Error adding event member:", err);
    res.status(500).json({ error: "Failed to add member" });
  }
});

// Remove user from event
app.delete("/events/:eventId/members/:userId", ensureAuthenticated, async (req, res) => {
  try {
    await pool.query("DELETE FROM event_members WHERE event_id=$1 AND user_id=$2", [req.params.eventId, req.params.userId]);
    res.json({ success: true, message: "User removed from event" });
  } catch (err) {
    console.error("Error removing event member:", err);
    res.status(500).json({ error: "Failed to remove member" });
  }
});

// ---- Organisations Management ----

// Get all organisations (protected)
app.get("/organisations", ensureAuthenticated, async (req, res) => {
  try {
    const rawType = (req.query.type || "").toString().trim().toLowerCase();
    const allowedTypes = ["client", "agency", "supplier"];

    if (allowedTypes.includes(rawType)) {
      const result = await pool.query(
        "SELECT * FROM organisations WHERE type = $1 ORDER BY created_at DESC",
        [rawType]
      );
      console.log('[GET /organisations] filter type =', rawType, 'rows =', result.rows.length);
      return res.json(result.rows);
    }

    // If a type param was provided but is invalid, return empty set (do not fallback to ALL)
    if (req.query.type !== undefined) {
      return res.json([]);
    }

    const result = await pool.query(
      "SELECT * FROM organisations ORDER BY created_at DESC"
    );
    console.log('[GET /organisations] no type filter, rows =', result.rows.length);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching organisations:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get a single organisation by ID
app.get("/organisations/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM organisations WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Organisation not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching organisation:", err);
    res.status(500).json({ error: err.message });
  }
});

// Create a new organisation (with optional logo upload)
app.post("/organisations", upload.single("logo"), async (req, res) => {
  try {
    const { name, currency, type } = req.body;
    console.log('[POST /organisations] raw body:', req.body);
    const rawType = (type || 'client').toString().trim().toLowerCase();
    const allowedTypes = ['client','agency','supplier'];
    const safeType = allowedTypes.includes(rawType) ? rawType : 'client';
    console.log('[POST /organisations] incoming type =', type, 'normalized =', safeType);
    let logo_url = null;
    if (req.file) {
      logo_url = `/uploads/${req.file.filename}`;
    }
    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }
    const result = await pool.query(
      `INSERT INTO organisations (name, currency, logo_url, type)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, currency || null, logo_url, safeType]
    );
    console.log('[POST /organisations] created id', result.rows[0].id, 'type', result.rows[0].type);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error creating organisation:", err);
    res.status(500).json({ error: err.message });
  }
});

// Update an organisation by ID (with optional logo upload)
app.put("/organisations/:id", upload.single("logo"), async (req, res) => {
  try {
    const { name, currency, type } = req.body;
    console.log('[PUT /organisations/:id] raw body:', req.body);
    let logo_url = null;
    if (req.file) {
      logo_url = `/uploads/${req.file.filename}`;
    }

    // Fetch existing organisation to check if exists and get current logo_url
    const existingResult = await pool.query("SELECT * FROM organisations WHERE id = $1", [req.params.id]);
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: "Organisation not found" });
    }
    const existingOrg = existingResult.rows[0];

    // If no new logo uploaded, keep the old one
    if (!logo_url) {
      logo_url = existingOrg.logo_url;
    } else {
      // If new logo uploaded and old logo exists, delete old logo file
      if (existingOrg.logo_url) {
        const oldLogoPath = path.join(__dirname, existingOrg.logo_url);
        fs.unlink(oldLogoPath, (err) => {
          if (err) {
            console.error("Error deleting old logo file:", err);
          }
        });
      }
    }

    const updatedName = name !== undefined ? name : existingOrg.name;
    const updatedCurrency = currency !== undefined ? currency : existingOrg.currency;

    const rawType = ((type ?? existingOrg.type) ?? 'client').toString().trim().toLowerCase();
    const allowedTypes = ['client','agency','supplier'];
    const safeType = allowedTypes.includes(rawType) ? rawType : (existingOrg.type || 'client');
    console.log('[PUT /organisations/:id] incoming type =', type, 'normalized =', safeType, 'for id', req.params.id);

    const result = await pool.query(
      `UPDATE organisations
       SET name=$1, currency=$2, logo_url=$3, type=$4
       WHERE id=$5
       RETURNING *`,
      [updatedName, updatedCurrency, logo_url, safeType, req.params.id]
    );
    console.log('[PUT /organisations/:id] updated id', result.rows[0].id, 'type', result.rows[0].type);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating organisation:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete an organisation and related events by ID
app.delete("/organisations/:id", async (req, res) => {
  try {
    // First fetch organisation to delete logo file if exists
    const existingResult = await pool.query("SELECT * FROM organisations WHERE id = $1", [req.params.id]);
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: "Organisation not found" });
    }
    const organisation = existingResult.rows[0];
    if (organisation.logo_url) {
      const logoPath = path.join(__dirname, organisation.logo_url);
      fs.unlink(logoPath, (err) => {
        if (err) {
          console.error("Error deleting logo file:", err);
        }
      });
    }

    // Delete related events first (assuming events.organisation references organisations.id)
    await pool.query("DELETE FROM events WHERE organisation_id = $1", [req.params.id]);

    // Delete organisation
    const result = await pool.query("DELETE FROM organisations WHERE id = $1 RETURNING *", [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Organisation not found" });
    }
    res.json({ success: true, message: "Organisation and related events deleted" });
  } catch (err) {
    console.error("Error deleting organisation:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Lots Management ----

// Get lots for an event (protected)
app.get("/events/:id/lots", ensureAuthenticated, async (req, res) => {
  try {
    const lots = await pool.query(
      "SELECT * FROM lots WHERE event_id = $1 ORDER BY id ASC",
      [req.params.id]
    );
    res.json(lots.rows);
  } catch (err) {
    console.error("Error fetching lots:", err);
    res.status(500).json({ error: err.message });
  }
});

// Create a new lot for an event
app.post("/events/:id/lots", async (req, res) => {
  try {
    const { title, description } = req.body;
    const newLot = await pool.query(
      `INSERT INTO lots (event_id, title, description)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.params.id, title, description]
    );
    res.json(newLot.rows[0]);
  } catch (err) {
    console.error("Error creating lot:", err);
    res.status(500).json({ error: err.message });
  }
});

// Update a lot by ID
app.put("/lots/:id", async (req, res) => {
  try {
    const { title, description } = req.body;
    const result = await pool.query(
      `UPDATE lots 
       SET title=$1, description=$2
       WHERE id=$3
       RETURNING *`,
      [title, description, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Lot not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating lot:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get a single lot by ID
app.get("/lots/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM lots WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Lot not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching lot:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Line Items Management ----

// Get all line items for a lot
app.get("/lots/:id/line-items", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM line_items WHERE lot_id = $1 ORDER BY id ASC",
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching line items:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get all line items for all lots in an event (joined with lot title)
app.get("/events/:id/line-items", ensureAuthenticated, async (req, res) => {
  try {
    const eventId = req.params.id;
    const result = await pool.query(`
      SELECT li.*, l.title AS lot_title
      FROM line_items li
      JOIN lots l ON li.lot_id = l.id
      WHERE l.event_id = $1
      ORDER BY l.id ASC, li.id ASC
    `, [eventId]);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching event line items:", err);
    res.status(500).json({ error: "Failed to fetch event line items" });
  }
});

// Create a new line item for a lot
app.post("/lots/:id/line-items", async (req, res) => {
  try {
    for (const key in req.body) {
      if (req.body[key] === '') req.body[key] = null;
    }

    const {
      item_number, item_name, group_number, description, quantity, uom,
      input, required, ties, decimals, decrement, opening_value,
      baseline, ext_quantity, ext_baseline, reserve_value, incumbent,
      weighting_visible, opening_visible, reserve_visible
    } = req.body;

    const result = await pool.query(
      `INSERT INTO line_items (
        lot_id, item_number, item_name, group_number, description, quantity, uom,
        input, required, ties, decimals, decrement, opening_value,
        baseline, ext_quantity, ext_baseline, reserve_value, incumbent,
        weighting_visible, opening_visible, reserve_visible
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,
        $8,$9,$10,$11,$12,$13,
        $14,$15,$16,$17,$18,
        $19,$20,$21
      )
      RETURNING *`,
      [
        req.params.id, item_number, item_name, group_number, description, quantity, uom,
        input, required, ties, decimals, decrement, opening_value,
        baseline, ext_quantity, ext_baseline, reserve_value, incumbent,
        weighting_visible, opening_visible, reserve_visible
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error creating line item:", err);
    res.status(500).json({ error: err.message });
  }
});

// Update a line item by ID
app.put("/line-items/:id", async (req, res) => {
  try {
    for (const key in req.body) {
      if (req.body[key] === '') req.body[key] = null;
    }

    const {
      item_number, item_name, group_number, description, quantity, uom,
      input, required, ties, decimals, decrement, opening_value,
      baseline, ext_quantity, ext_baseline, reserve_value, incumbent,
      weighting_visible, opening_visible, reserve_visible
    } = req.body;

    const result = await pool.query(
      `UPDATE line_items SET
        item_number=$1, item_name=$2, group_number=$3, description=$4, quantity=$5, uom=$6,
        input=$7, required=$8, ties=$9, decimals=$10, decrement=$11, opening_value=$12,
        baseline=$13, ext_quantity=$14, ext_baseline=$15, reserve_value=$16, incumbent=$17,
        weighting_visible=$18, opening_visible=$19, reserve_visible=$20
       WHERE id=$21
       RETURNING *`,
      [
        item_number, item_name, group_number, description, quantity, uom,
        input, required, ties, decimals, decrement, opening_value,
        baseline, ext_quantity, ext_baseline, reserve_value, incumbent,
        weighting_visible, opening_visible, reserve_visible,
        req.params.id
      ]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Line item not found" });

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating line item:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a line item by ID
app.delete("/line-items/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM line_items WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Line item not found" });
    }
    res.json({ success: true, message: "Line item deleted" });
  } catch (err) {
    console.error("Error deleting line item:", err);
    res.status(500).json({ error: err.message });
  }
});

// === Supplier Line Item Settings ===

// POST /events/:eventId/line-items/:lineItemId/supplier-settings
app.post("/events/:eventId/line-items/:lineItemId/supplier-settings", ensureAuthenticated, async (req, res) => {
  try {
    const { eventId, lineItemId } = req.params;
    const { supplier_id, weighting, opening_bid } = req.body;
    if (!supplier_id) {
      return res.status(400).json({ error: "supplier_id is required" });
    }

    let w = weighting;
    let ob = opening_bid;
    if (w !== undefined && w !== null && w !== "") {
      if (isNaN(Number(w))) return res.status(400).json({ error: "weighting must be a number" });
      w = Number(w);
    } else {
      w = 1.0;
    }
    if (ob !== undefined && ob !== null && ob !== "") {
      if (isNaN(Number(ob))) return res.status(400).json({ error: "opening_bid must be a number" });
      ob = Number(ob);
    } else {
      ob = null;
    }

    const result = await pool.query(
      `
      INSERT INTO supplier_line_item_settings (event_id, line_item_id, supplier_id, weighting, opening_bid)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (event_id, line_item_id, supplier_id)
      DO UPDATE SET weighting=EXCLUDED.weighting, opening_bid=EXCLUDED.opening_bid
      RETURNING *;
      `,
      [eventId, lineItemId, supplier_id, w, ob]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error upserting supplier_line_item_settings:", err);
    res.status(500).json({ error: "Failed to upsert supplier settings" });
  }
});

// GET /events/:eventId/line-items/:lineItemId/supplier-settings
app.get("/events/:eventId/line-items/:lineItemId/supplier-settings", ensureAuthenticated, async (req, res) => {
  try {
    const { eventId, lineItemId } = req.params;
    const result = await pool.query(
      `
      SELECT s.*, u.first_name, u.last_name, u.email
      FROM supplier_line_item_settings s
      JOIN users u ON s.supplier_id = u.id
      WHERE s.event_id = $1 AND s.line_item_id = $2
      ORDER BY u.first_name ASC
      `,
      [eventId, lineItemId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching supplier_line_item_settings:", err);
    res.status(500).json({ error: "Failed to fetch supplier settings" });
  }
});

// === Line Item Assignments ===

// Get all line items for a bidder within a specific event (shows assigned flag)
app.get("/events/:eventId/bidders/:userId/line-items", ensureAuthenticated, async (req, res) => {
  try {
    const { eventId, userId } = req.params;

    // Only allow managers or the bidder themselves to view
    if (req.user.role !== "manager" && req.user.id != userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const result = await pool.query(`
      SELECT li.*, l.title AS lot_title,
             CASE WHEN bia.user_id IS NOT NULL THEN TRUE ELSE FALSE END AS assigned
      FROM lots l
      JOIN line_items li ON li.lot_id = l.id
      LEFT JOIN bidder_item_assignments bia 
        ON bia.line_item_id = li.id AND bia.user_id = $2
      WHERE l.event_id = $1
      ORDER BY l.id ASC, li.id ASC
    `, [eventId, userId]);

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching bidder line items:", err);
    res.status(500).json({ error: "Failed to fetch bidder line items" });
  }
});

// Save bidder's line item assignments
app.post("/events/:eventId/bidders/:userId/line-items", ensureAuthenticated, async (req, res) => {
  try {
    const { eventId, userId } = req.params;
    const { assignedItemIds } = req.body;

    if (!Array.isArray(assignedItemIds)) {
      return res.status(400).json({ error: "Invalid data format" });
    }

    // Only managers can update assignments
    if (req.user.role !== "manager") {
      return res.status(403).json({ error: "Access denied" });
    }

    // Clear existing assignments for this bidder in the event
    await pool.query(`
      DELETE FROM bidder_item_assignments
      WHERE user_id = $1 AND line_item_id IN (
        SELECT li.id
        FROM line_items li
        JOIN lots l ON li.lot_id = l.id
        WHERE l.event_id = $2
      )
    `, [userId, eventId]);

    // Reinsert new assignments
    for (const itemId of assignedItemIds) {
      await pool.query(
        `INSERT INTO bidder_item_assignments (user_id, line_item_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, itemId]
      );
    }

    res.json({ success: true, message: "Assignments updated successfully" });
  } catch (err) {
    console.error("Error saving bidder line item assignments:", err);
    res.status(500).json({ error: "Failed to save bidder line item assignments" });
  }
});

// === Line Items Import/Export (Excel) ===

// Export line items as Excel file (styled like on-screen table, no Actions column)
app.get("/lots/:id/line-items/export", async (req, res) => {
  try {
    const lotId = req.params.id;
    const result = await pool.query(
      "SELECT * FROM line_items WHERE lot_id = $1 ORDER BY id ASC",
      [lotId]
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Line Items");

    // === Header Groups ===
    sheet.addRow([
      "Core Info", "", "", "", "", "", "",
      "Bid Settings", "", "", "", "", "",
      "Evaluative Settings", "", "", "", "",
      "Bid Interface Visibility", "", ""
    ]);

    // === Column Labels ===
    sheet.addRow([
      "Item #", "Item Name", "Group #", "Description", "Qty", "UOM", "Extra",
      "Input", "Required", "Ties", ".00", "Decrement", "Opening",
      "Baseline", "Ext Qty", "Ext Base", "Reserve", "Incumbent",
      "Weighting", "Opening", "Reserve"
    ]);

    // === Merge Header Ranges ===
    sheet.mergeCells("A1:G1");   // Core Info (7)
    sheet.mergeCells("H1:M1");   // Bid Settings (6)
    sheet.mergeCells("N1:R1");   // Evaluative Settings (5)
    sheet.mergeCells("S1:U1");   // Bid Interface Visibility (3)

    // === Header Styling ===
    const headerGroupRow = sheet.getRow(1);
    const headerLabelRow = sheet.getRow(2);
    const lightGrey = { argb: "FFF3F3F3" };
    const darkGrey = { argb: "FFDCDCDC" };

    headerGroupRow.eachCell(cell => {
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: darkGrey };
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" }
      };
    });

    headerLabelRow.eachCell(cell => {
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: lightGrey };
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" }
      };
    });

    // === Data Rows (no borders) ===
    result.rows.forEach(r => {
      const row = sheet.addRow([
        r.item_number, r.item_name, r.group_number, r.description, r.quantity, r.uom, null,
        r.input, r.required, r.ties, r.decimals, r.decrement, r.opening_value,
        r.baseline, r.ext_quantity, r.ext_baseline, r.reserve_value, r.incumbent,
        r.weighting_visible, r.opening_visible, r.reserve_visible
      ]);
      row.eachCell(cell => {
        cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
      });
    });

    // === Column Widths (balanced) ===
    const widths = [
      10, 20, 10, 25, 10, 10, 10, // Core Info (7)
      10, 10, 10, 8, 10, 10,      // Bid Settings (6)
      10, 10, 10, 10, 15,         // Evaluative (5)
      10, 10, 10                  // Visibility (3)
    ];
    widths.forEach((w, i) => (sheet.getColumn(i + 1).width = w));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="lot_${lotId}_line_items.xlsx"`
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error exporting Excel:", err);
    res.status(500).send("Error exporting Excel");
  }
});

// Import line items from Excel (matches 7 / 6 / 5 / 3 structure)
app.post("/lots/:id/line-items/import", upload.single("file"), async (req, res) => {
  const lotId = req.params.id;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(req.file.path);
    const sheet = workbook.worksheets[0];

    // Skip first 2 header rows
    const startRow = 3;

    for (let i = startRow; i <= sheet.rowCount; i++) {
      const row = sheet.getRow(i);
      if (!row || !row.getCell(1).value) continue; // skip blank rows

      const [
        item_number, item_name, group_number, description, quantity, uom, extra,
        input, required, ties, decimals, decrement, opening_value,
        baseline, ext_quantity, ext_baseline, reserve_value, incumbent,
        weighting_visible, opening_visible, reserve_visible
      ] = row.values.slice(1, 22); // slice off ExcelJS index 0 (unused)

      await pool.query(
        `INSERT INTO line_items (
          lot_id, item_number, item_name, group_number, description, quantity, uom,
          input, required, ties, decimals, decrement, opening_value,
          baseline, ext_quantity, ext_baseline, reserve_value, incumbent,
          weighting_visible, opening_visible, reserve_visible
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,
          $8,$9,$10,$11,$12,$13,
          $14,$15,$16,$17,$18,
          $19,$20,$21
        )`,
        [
          lotId, item_number, item_name, group_number, description, quantity, uom,
          input,
          required === true || required === "true",
          ties ? String(ties) : null,
          parseInt(decimals) || 0, decrement, opening_value,
          baseline, ext_quantity, ext_baseline, reserve_value, incumbent,
          weighting_visible === true || weighting_visible === "true",
          opening_visible === true || opening_visible === "true",
          reserve_visible === true || reserve_visible === "true"
        ]
      );
    }

    fs.unlinkSync(req.file.path);
    res.json({ success: true, message: "✅ Excel imported successfully" });
  } catch (err) {
    console.error("Error importing Excel:", err);
    res.status(500).json({ error: "Failed to import Excel" });
  }
});

// Serve invite page
app.get("/invite/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "invite.html"));
});

// Serve start (login) page
app.get("/start.html", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "start.html"));
});

// Serve manager dashboard page
app.get("/manager.html", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "manager.html"));
});

// Serve bidder dashboard page
app.get("/bidder.html", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "bidder.html"));
});

// Serve bidder account page
app.get("/bidderaccount.html", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "bidderaccount.html"));
});

// === Clear all users and invitations for testing ===
app.post("/admin/clear-test-data", async (req, res) => {
  try {
    await pool.query("TRUNCATE TABLE invitations RESTART IDENTITY CASCADE;");
    await pool.query("TRUNCATE TABLE users RESTART IDENTITY CASCADE;");
    res.json({ success: true, message: "All users and invitations cleared." });
  } catch (err) {
    console.error("Error clearing test data:", err);
    res.status(500).json({ error: "Failed to clear test data" });
  }
});




// ---- Messaging: Global Socket.IO with JWT Auth, BroadcastChannel Sync ----
const JWT_SECRET = SECRET;
io.on("connection", (socket) => {
  console.log("🔌 User connected to messaging");

  // Authenticate user if token is provided
  const token = socket.handshake.auth?.token;
  if (!token) {
    console.log("❌ Socket connection rejected: missing token");
    socket.disconnect();
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    socket.join(`user_${decoded.id}`);
    console.log(`✅ ${decoded.email} connected to messaging`);

    // === Auction Real-Time Events (Authenticated) ===
    socket.on("join_lot", (lotId) => {
      socket.join(`lot_${lotId}`);
      console.log(`Client joined lot ${lotId}`);
    });

    socket.on("join_event", (eventId) => {
      socket.join(`event_${eventId}`);
      console.log(`Client joined event ${eventId}`);
      io.to(`event_${eventId}`).emit("bidders_count_update");
    });

    socket.on("new_bid", async (data) => {
      try {
        const { event_id, line_item_id, amount } = data || {};
        if (!event_id || !amount || isNaN(Number(amount))) return;
        const user_id = socket.user.id; // ignore any client-sent user_id

        const insert = await pool.query(
          `INSERT INTO bids (event_id, user_id, line_item_id, amount)
           VALUES ($1, $2, $3, $4)
           RETURNING id, event_id, user_id, line_item_id, amount, created_at`,
          [event_id, user_id, line_item_id || null, amount]
        );
        const bid = insert.rows[0];

        // attach display_name for the frontend
        const ures = await pool.query(
          `SELECT first_name, last_name, email FROM users WHERE id=$1`,
          [user_id]
        );
        const u = ures.rows[0] || {};
        bid.display_name = `${(u.first_name || "").trim()} ${(u.last_name || "").trim()}`.trim() || u.email || `User ${user_id}`;

        io.to(`event_${event_id}`).emit("bid_update", bid);
      } catch (err) {
        console.error("Error saving socket bid:", err);
      }
    });
    // === End Auction Real-Time Events (Authenticated) ===
  } catch (err) {
    console.error("❌ Invalid token:", err.message);
    socket.disconnect();
    return;
  }


  socket.on("disconnect", () => {
    console.log(`⚡️ ${socket.user?.email || "Unknown user"} disconnected`);
  });
});

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

// The /migrate route is now redundant; migrations run automatically on startup.
// app.get("/migrate", async (req, res) => {
//   res.status(410).json({ error: "Migrations now run automatically on startup." });
// });

// === Get all events a bidder is assigned to ===
app.get("/bidders/:userId/events", ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = req.params;

    // Optional: only allow users to view their own events unless manager
    if (req.user.role !== "manager" && req.user.id != userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const result = await pool.query(`
      SELECT e.*, 
             o.name AS organisation_name,
             c.name AS category_name
      FROM event_members em
      JOIN events e ON em.event_id = e.id
      LEFT JOIN organisations o ON e.organisation_id = o.id
      LEFT JOIN categories c ON e.category_id = c.id
      WHERE em.user_id = $1
      ORDER BY e.auction_time ASC NULLS LAST
    `, [userId]);

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching bidder events:", err);
    res.status(500).json({ error: "Failed to fetch bidder events" });
  }
});

// === CATEGORY ROUTES ===

// Get all categories for an organisation
app.get("/organisations/:orgId/categories", ensureAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM categories WHERE organisation_id = $1 ORDER BY created_at DESC",
      [req.params.orgId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching categories:", err);
    res.status(500).send("Error fetching categories");
  }
});

// Create a new category under an organisation
app.post("/organisations/:orgId/categories", ensureAuthenticated, async (req, res) => {
  try {
    const { name, description } = req.body;
    const result = await pool.query(
      `INSERT INTO categories (organisation_id, name, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.orgId, name, description]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error creating category:", err);
    res.status(500).send("Error creating category");
  }
});

// Update category
app.put("/categories/:id", ensureAuthenticated, async (req, res) => {
  try {
    const { name, description } = req.body;
    const result = await pool.query(
      `UPDATE categories
       SET name = $1, description = $2
       WHERE id = $3 RETURNING *`,
      [name, description, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating category:", err);
    res.status(500).send("Error updating category");
  }
});

// Delete category
app.delete("/categories/:id", ensureAuthenticated, async (req, res) => {
  try {
    await pool.query("DELETE FROM categories WHERE id = $1", [req.params.id]);
    res.sendStatus(204);
  } catch (err) {
    console.error("Error deleting category:", err);
    res.status(500).send("Error deleting category");
  }
});


// === RFQ (Request for Quotation) Management ===

// Get RFQ for an event
app.get("/events/:id/rfq", ensureAuthenticated, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM rfqs WHERE event_id = $1 LIMIT 1",
      [req.params.id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error("Error fetching RFQ:", err);
    res.status(500).json({ error: "Failed to fetch RFQ" });
  }
});

// Save or publish RFQ for an event
app.post("/events/:id/rfq", ensureAuthenticated, async (req, res) => {
  try {
    const { info, publish_time, deadline_time, reminder_time, publish } = req.body;
    const eventId = req.params.id;

    if (!info || !publish_time || !deadline_time)
      return res.status(400).json({ error: "Missing required fields" });

    // Check if one exists
    const existing = await pool.query("SELECT * FROM rfqs WHERE event_id = $1", [eventId]);
    let rfq;

    if (existing.rows.length > 0) {
      rfq = await pool.query(
        `UPDATE rfqs 
         SET info=$1, publish_time=$2, deadline_time=$3, reminder_time=$4, published=$5
         WHERE event_id=$6 RETURNING *`,
        [info, publish_time, deadline_time, reminder_time, publish, eventId]
      );
    } else {
      rfq = await pool.query(
        `INSERT INTO rfqs (event_id, info, publish_time, deadline_time, reminder_time, published)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [eventId, info, publish_time, deadline_time, reminder_time, publish]
      );
    }

    // If publish=true → send RFQ email to all bidders
    if (publish) {
      const bidders = await pool.query(
        `SELECT u.email, u.first_name 
         FROM event_members em
         JOIN users u ON u.id = em.user_id
         WHERE em.event_id=$1 AND u.role='bidder'`,
        [eventId]
      );

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      for (const bidder of bidders.rows) {
        await transporter.sendMail({
          from: `"TenderSmith Auctions" <${process.env.EMAIL_USER}>`,
          to: bidder.email,
          subject: "Request for Quotation - Please Respond",
          html: `
            <p>Hello ${bidder.first_name || ""},</p>
            <p>${info.replace(/\n/g, "<br>")}</p>
            <p>Deadline: <strong>${new Date(deadline_time).toLocaleString()}</strong></p>
          `,
        });
      }

      // Notify manager
      const manager = await pool.query(
        `SELECT u.email FROM users u
         JOIN events e ON e.created_by = u.id
         WHERE e.id=$1`,
        [eventId]
      );
      if (manager.rows[0]) {
        await transporter.sendMail({
          from: `"TenderSmith Auctions" <${process.env.EMAIL_USER}>`,
          to: manager.rows[0].email,
          subject: "RFQ Published Confirmation",
          html: `<p>Your RFQ for Event #${eventId} has been published successfully.</p>`,
        });
      }
    }

    res.json(rfq.rows[0]);
  } catch (err) {
    console.error("Error saving RFQ:", err);
    res.status(500).json({ error: "Failed to save RFQ" });
  }
});

// Periodically check for RFQs ready to publish
setInterval(async () => {
  try {
    const due = await pool.query(
      `SELECT * FROM rfqs WHERE published=false AND publish_time <= NOW()`
    );
    for (const rfq of due.rows) {
      await pool.query(`UPDATE rfqs SET published=true WHERE id=$1`, [rfq.id]);

      const bidders = await pool.query(
        `SELECT u.email, u.first_name 
         FROM event_members em
         JOIN users u ON u.id = em.user_id
         WHERE em.event_id=$1 AND u.role='bidder'`,
        [rfq.event_id]
      );

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      for (const bidder of bidders.rows) {
        await transporter.sendMail({
          from: `"TenderSmith Auctions" <${process.env.EMAIL_USER}>`,
          to: bidder.email,
          subject: "Request for Quotation - Please Respond",
          html: `<p>Hello ${bidder.first_name || ""},</p><p>${rfq.info.replace(/\n/g, "<br>")}</p>`,
        });
      }

      console.log(`📨 Published RFQ for event ${rfq.event_id}`);
    }
  } catch (err) {
    console.error("RFQ publish scheduler error:", err);
  }
}, 60000);


// === Sealed Event Bidder Reveal and Masking Support ===

// === Reveal Bidders (Manager Only) ===
app.post("/events/:id/reveal-bidders", ensureAuthenticated, async (req, res) => {
  try {
    if (req.user.role !== "manager") {
      return res.status(403).json({ error: "Not authorized" });
    }
    await pool.query("UPDATE events SET reveal_bidders = TRUE WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Bidders revealed for this event." });
  } catch (err) {
    console.error("Error revealing bidders:", err);
    res.status(500).json({ error: "Failed to reveal bidders" });
  }
});

// === Get Bids for Event with Masking Support (Fixed visibility for sealed auctions) ===
app.get("/events/:id/bids", ensureAuthenticated, async (req, res) => {
  try {
    const eventId = req.params.id;
    const userId = req.user.id;
    const role = req.user.role;

    // Fetch event info
    const eventResult = await pool.query(
      "SELECT type, reveal_bidders FROM events WHERE id=$1",
      [eventId]
    );
    if (eventResult.rows.length === 0)
      return res.status(404).json({ error: "Event not found" });
    const event = eventResult.rows[0];

    // Always return bids, but filter for bidders
    let bidsQuery = `
      SELECT 
        b.id, 
        b.amount, 
        b.created_at,
        b.line_item_id,
        b.user_id AS bidder_id, 
        u.first_name, 
        u.last_name, 
        u.email
      FROM bids b
      LEFT JOIN users u ON b.user_id = u.id
      WHERE b.event_id = $1
      ORDER BY b.created_at DESC
    `;

    const bidsResult = await pool.query(bidsQuery, [eventId]);
    let bids = bidsResult.rows;

    // === ROLE LOGIC ===
    if (role === "bidder") {
      // Bidders only see their own bids
      bids = bids.filter((b) => b.bidder_id === userId);
      // Add rank calculation per line item
      for (const b of bids) {
        const rankResult = await pool.query(
          `
          SELECT COUNT(*) + 1 AS rank
          FROM (
            SELECT DISTINCT ON (user_id) user_id, amount
            FROM bids
            WHERE event_id = $1 AND line_item_id = $2
            ORDER BY user_id, created_at DESC
          ) AS latest_bids
          WHERE latest_bids.amount < $3
        `,
          [eventId, b.line_item_id, b.amount]
        );
        b.rank = parseInt(rankResult.rows[0].rank, 10);
      }
      return res.json(bids);
    }

    // === MANAGERS ===
    if (role === "manager") {
      // Managers always see all bids
      if (event.type === "sealed" && !event.reveal_bidders) {
        // Mask bidder names, but keep bids visible
        const nameMap = {};
        let counter = 0;
        for (const b of bids) {
          if (!nameMap[b.bidder_id]) {
            nameMap[b.bidder_id] = `Company ${String.fromCharCode(65 + counter++)}`;
          }
          b.display_name = nameMap[b.bidder_id];
        }
      } else {
        // Open or revealed → show real names
        for (const b of bids) {
          b.display_name =
            `${b.first_name || ""} ${b.last_name || ""}`.trim() || b.email;
        }
      }
      return res.json(bids);
    }

    // Default fallback (no role match)
    res.status(403).json({ error: "Unauthorized role" });
  } catch (err) {
    console.error("Error fetching bids:", err);
    res.status(500).json({ error: "Failed to fetch bids" });
  }
});

// === Get Live Auction Stats ===
app.get("/events/:id/stats", ensureAuthenticated, async (req, res) => {
  try {
    const eventId = req.params.id;

    // Get total bids and most recent timestamp
    const bids = await pool.query(
      `SELECT COUNT(*) AS total_bids, MAX(created_at) AS last_bid_time FROM bids WHERE event_id=$1`,
      [eventId]
    );

    // Get total unique bidders
    const uniqueBidders = await pool.query(
      `SELECT COUNT(DISTINCT user_id) AS bidders_connected FROM bids WHERE event_id=$1`,
      [eventId]
    );

    // Get total event members (for bidder count)
    const totalMembers = await pool.query(
      `SELECT COUNT(*) AS total_bidders FROM event_members WHERE event_id=$1 AND role='bidder'`,
      [eventId]
    );

    // Get event details for countdown
    const eventResult = await pool.query(
      `SELECT auction_time, type FROM events WHERE id=$1`,
      [eventId]
    );
    const event = eventResult.rows[0];

    res.json({
      total_bids: Number(bids.rows[0].total_bids || 0),
      bidders_connected: Number(uniqueBidders.rows[0].bidders_connected || 0),
      total_bidders: Number(totalMembers.rows[0].total_bidders || 0),
      last_bid_time: bids.rows[0].last_bid_time,
      auction_time: event ? event.auction_time : null,
      type: event ? event.type : null,
      extensions: 0 // placeholder for now until extension tracking is implemented
    });
  } catch (err) {
    console.error("Error fetching live auction stats:", err);
    res.status(500).json({ error: "Failed to fetch auction stats" });
  }
});

// === Get Bidder-Specific Line Items with Ranks ===
app.get("/events/:id/bidder-lineitems", ensureAuthenticated, async (req, res) => {
  try {
    const eventId = req.params.id;
    const userId = req.user.id;

    // Only bidders can access this endpoint (managers have their own views)
    if (req.user.role !== "bidder") {
      return res.status(403).json({ error: "Access restricted to bidders only" });
    }

    // Get all line items assigned to this bidder in the event, with most recent bid for each
    const itemsResult = await pool.query(`
      SELECT li.id,
             li.item_name AS name,
             li.quantity,
             li.ext_quantity,
             b.amount AS current_bid
      FROM line_items li
      JOIN lots l ON li.lot_id = l.id
      JOIN bidder_item_assignments bia
        ON bia.line_item_id = li.id AND bia.user_id = $2
      LEFT JOIN LATERAL (
        SELECT amount
        FROM bids
        WHERE line_item_id = li.id
          AND user_id = $2
          AND event_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      ) b ON TRUE
      WHERE l.event_id = $1
      ORDER BY li.id ASC
    `, [eventId, userId]);

    const lineItems = itemsResult.rows;

    // Calculate ranks for each line item, scoped to event and handling nulls
    for (const item of lineItems) {
      if (item.current_bid == null) {
        item.rank = null;
      } else {
        const rankResult = await pool.query(`
          SELECT COUNT(*) + 1 AS rank
          FROM bids
          WHERE line_item_id = $1
            AND event_id = $2
            AND amount < $3
        `, [item.id, eventId, item.current_bid]);
        item.rank = parseInt(rankResult.rows[0].rank, 10);
      }
    }

    res.json(lineItems);
  } catch (err) {
    console.error("Error fetching bidder line items with ranks:", err);
    res.status(500).json({ error: "Failed to fetch bidder line items" });
  }
});

// === Get Rank for a Single Line Item (Fast Lookup) ===
app.get("/events/:eventId/line-items/:lineItemId/rank", ensureAuthenticated, async (req, res) => {
  try {
    const { eventId, lineItemId } = req.params;
    const userId = req.user.id;

    // Must be a bidder
    if (req.user.role !== "bidder") {
      return res.status(403).json({ error: "Access restricted to bidders only" });
    }

    // Get this bidder’s latest bid for that line item
    const bidResult = await pool.query(`
      SELECT amount
      FROM bids
      WHERE event_id=$1 AND line_item_id=$2 AND user_id=$3
      ORDER BY created_at DESC
      LIMIT 1
    `, [eventId, lineItemId, userId]);

    if (bidResult.rows.length === 0) {
      return res.json({ rank: null });
    }

    const currentBid = bidResult.rows[0].amount;

    // Compute rank based on latest bid per user for that line item
    const rankResult = await pool.query(`
      SELECT COUNT(*) + 1 AS rank
      FROM (
        SELECT DISTINCT ON (user_id) user_id, amount
        FROM bids
        WHERE event_id = $1 AND line_item_id = $2
        ORDER BY user_id, created_at DESC
      ) AS latest_bids
      WHERE latest_bids.amount < $3
    `, [eventId, lineItemId, currentBid]);

    res.json({ rank: parseInt(rankResult.rows[0].rank, 10) });
  } catch (err) {
    console.error("Error fetching line item rank:", err);
    res.status(500).json({ error: "Failed to fetch rank" });
  }
});
// --- Get all users for an organisation ---
app.get("/organisations/:id/users", ensureAuthenticated, async (req, res) => {
  try {
    const orgId = req.params.id;
    const result = await pool.query(
      `SELECT id, first_name, last_name, email, role 
       FROM users WHERE organisation_id = $1 ORDER BY first_name ASC`,
      [orgId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching organisation users:", err);
    res.status(500).json({ error: "Failed to fetch organisation users" });
  }
});