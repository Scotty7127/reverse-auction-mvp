// routes/route-events.js
const express = require("express");
const { ensureAuthenticated } = require("../middleware/auth");
const pool = require("../db/pool");
const jwt = require("jsonwebtoken");

const router = express.Router();

  // === Get all events a bidder is assigned to ===
  router.get("/bidders/:userId/events", ensureAuthenticated, async (req, res) => {
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

module.exports = (io) => {
  // Helper to normalize interval fields (returns interval string for Postgres)
  function normalizeInterval(value, unit) {
    if (value === null || typeof value === "undefined" || value === "") return null;
    let num = Number(value);
    if (isNaN(num) || num <= 0) return null;
    num = Math.round(num);
    return `${num} ${unit}`;
  }

  // === Submit a new bid ===
  router.post("/events/:id/bids", ensureAuthenticated, async (req, res) => {
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
        `SELECT first_name, last_name, email FROM users WHERE id=$1`,
        [userId]
      );
      const u = ures.rows[0] || {};
      const display_name =
        `${(u.first_name || "").trim()} ${(u.last_name || "").trim()}`.trim() ||
        u.email ||
        `User ${userId}`;
      const enriched = { ...bid, display_name };
      io.to(`event_${eventId}`).emit("bid_update", enriched);
      res.json(enriched);
    } catch (err) {
      console.error("Error submitting bid:", err);
      res.status(500).json({ error: "Failed to submit bid" });
    }
  });

  // === Bulk Bid Submission ===
  router.post("/events/:id/bids/bulk", ensureAuthenticated, async (req, res) => {
    try {
      const eventId = req.params.id;
      const userId = req.user.id;
      const { bids } = req.body;

      if (!Array.isArray(bids) || bids.length === 0) {
        return res.status(400).json({ error: "No bids provided" });
      }

      const ures = await pool.query(
        `SELECT first_name, last_name, email FROM users WHERE id=$1`,
        [userId]
      );
      const u = ures.rows[0] || {};
      const display_name =
        `${(u.first_name || "").trim()} ${(u.last_name || "").trim()}`.trim() ||
        u.email ||
        `User ${userId}`;

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
        io.to(`event_${eventId}`).emit("bid_update", enriched);
      }

      res.json({ success: true, inserted: insertedBids.length });
    } catch (err) {
      console.error("Error submitting bulk bids:", err);
      res.status(500).json({ error: "Failed to submit bulk bids" });
    }
  });

  // === Pause & Resume Auctions ===
  router.patch("/events/:id/pause", ensureAuthenticated, async (req, res) => {
    if (req.user.role !== "manager") {
      return res.status(403).json({ error: "Only managers can pause auctions" });
    }
    await pool.query("UPDATE events SET type = 'paused' WHERE id=$1", [req.params.id]);
    io.to(`event_${req.params.id}`).emit("auction_paused");
    res.json({ success: true });
  });

  router.patch("/events/:id/resume", ensureAuthenticated, async (req, res) => {
    if (req.user.role !== "manager") {
      return res.status(403).json({ error: "Only managers can resume auctions" });
    }
    await pool.query("UPDATE events SET type = 'open' WHERE id=$1", [req.params.id]);
    io.to(`event_${req.params.id}`).emit("auction_resumed");
    res.json({ success: true });
  });

  // === Create Event ===
  router.post("/events", ensureAuthenticated, async (req, res) => {
    try {
      const {
        title,
        description,
        organisation_id,
        category_id,
        currency,
        support_contact,
        bid_manager,
        auction_time,
        type,
        auction_duration,
        extension_time,
        extension_threshold,
      } = req.body;
      const created_by = req.user.id;
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
          type || "open",
          auctionDurationInterval,
          extensionTimeInterval,
          extensionThresholdInterval,
        ]
      );
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error creating event:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // === Get All Events ===
  router.get("/events", ensureAuthenticated, async (req, res) => {
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

  // === Get Event by ID ===
  router.get("/events/:id", ensureAuthenticated, async (req, res) => {
    try {
      const eventResult = await pool.query(
        `
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
        `,
        [req.params.id]
      );

      if (eventResult.rows.length === 0) {
        return res.status(404).json({ error: "Event not found" });
      }
      res.json(eventResult.rows[0]);
    } catch (err) {
      console.error("Error fetching event:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // === Reveal Bidders (Manager only) ===
  router.post("/events/:id/reveal-bidders", ensureAuthenticated, async (req, res) => {
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

  // === Get Bids for Event (with masking support) ===
  router.get("/events/:id/bids", ensureAuthenticated, async (req, res) => {
    try {
      const eventId = req.params.id;
      const userId = req.user.id;
      const role = req.user.role;

      const eventResult = await pool.query(
        "SELECT type, reveal_bidders FROM events WHERE id=$1",
        [eventId]
      );
      if (eventResult.rows.length === 0)
        return res.status(404).json({ error: "Event not found" });
      const event = eventResult.rows[0];

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

      if (role === "bidder") {
        bids = bids.filter((b) => b.bidder_id === userId);
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

      if (role === "manager") {
        if (event.type === "sealed" && !event.reveal_bidders) {
          const nameMap = {};
          let counter = 0;
          for (const b of bids) {
            if (!nameMap[b.bidder_id]) {
              nameMap[b.bidder_id] = `Company ${String.fromCharCode(65 + counter++)}`;
            }
            b.display_name = nameMap[b.bidder_id];
          }
        } else {
          for (const b of bids) {
            b.display_name =
              `${b.first_name || ""} ${b.last_name || ""}`.trim() || b.email;
          }
        }
        return res.json(bids);
      }

      res.status(403).json({ error: "Unauthorized role" });
    } catch (err) {
      console.error("Error fetching bids:", err);
      res.status(500).json({ error: "Failed to fetch bids" });
    }
  });

  // === Get Auction Stats ===
  router.get("/events/:id/stats", ensureAuthenticated, async (req, res) => {
    try {
      const eventId = req.params.id;

      const bids = await pool.query(
        `SELECT COUNT(*) AS total_bids, MAX(created_at) AS last_bid_time FROM bids WHERE event_id=$1`,
        [eventId]
      );
      const uniqueBidders = await pool.query(
        `SELECT COUNT(DISTINCT user_id) AS bidders_connected FROM bids WHERE event_id=$1`,
        [eventId]
      );
      const totalMembers = await pool.query(
        `SELECT COUNT(*) AS total_bidders FROM event_members WHERE event_id=$1 AND role='bidder'`,
        [eventId]
      );
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
      });
    } catch (err) {
      console.error("Error fetching stats:", err);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // === Delete Event ===
  router.delete("/events/:id", ensureAuthenticated, async (req, res) => {
    try {
      const eventId = req.params.id;

      // Only allow managers to delete events
      if (req.user.role !== "manager") {
        return res.status(403).json({ error: "Only managers can delete events" });
      }

      await pool.query("DELETE FROM events WHERE id = $1", [eventId]);
      res.json({ success: true, message: "Event deleted successfully" });
    } catch (err) {
      console.error("Error deleting event:", err);
      res.status(500).json({ error: "Failed to delete event" });
    }
  });

  return router;
};