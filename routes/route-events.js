// routes/route-events.js
const express = require("express");
const { ensureAuthenticated } = require("../middleware/auth");
const { checkTeamMembership } = require("../middleware/team-access");
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
    try {
      if (req.user.role !== "manager") {
        return res.status(403).json({ error: "Only managers can pause auctions" });
      }

      const eventId = req.params.id;
      const userId = req.user.id;

      // Check if the manager is a team member of this event
      const isMember = await checkTeamMembership(eventId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "You are not a team member of this event" });
      }

      await pool.query("UPDATE events SET type = 'paused' WHERE id=$1", [eventId]);
      io.to(`event_${eventId}`).emit("auction_paused");
      res.json({ success: true });
    } catch (err) {
      console.error("Error pausing auction:", err);
      res.status(500).json({ error: "Failed to pause auction" });
    }
  });

  router.patch("/events/:id/resume", ensureAuthenticated, async (req, res) => {
    try {
      if (req.user.role !== "manager") {
        return res.status(403).json({ error: "Only managers can resume auctions" });
      }

      const eventId = req.params.id;
      const userId = req.user.id;

      // Check if the manager is a team member of this event
      const isMember = await checkTeamMembership(eventId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "You are not a team member of this event" });
      }

      await pool.query("UPDATE events SET type = 'open' WHERE id=$1", [eventId]);
      io.to(`event_${eventId}`).emit("auction_resumed");
      res.json({ success: true });
    } catch (err) {
      console.error("Error resuming auction:", err);
      res.status(500).json({ error: "Failed to resume auction" });
    }
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
        support_contact_country_code,
        support_contact_phone,
        bid_manager_name,
        bid_manager,
        bid_manager_country_code,
        bid_manager_phone,
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

      // Use a transaction to create event and add creator as team member
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const result = await client.query(
          `INSERT INTO events (title, description, organisation_id, category_id, currency, support_contact, support_contact_country_code, support_contact_phone, bid_manager_name, bid_manager, bid_manager_country_code, bid_manager_phone, created_by, auction_time, type, auction_duration, extension_time, extension_threshold)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           RETURNING *`,
          [
            title,
            description,
            organisation_id,
            category_id,
            currency,
            support_contact,
            support_contact_country_code,
            support_contact_phone,
            bid_manager_name,
            bid_manager,
            bid_manager_country_code,
            bid_manager_phone,
            created_by,
            auction_time,
            type || "open",
            auctionDurationInterval,
            extensionTimeInterval,
            extensionThresholdInterval,
          ]
        );

        const event = result.rows[0];

        // Add creator as team member with 'creator' role
        await client.query(
          `INSERT INTO event_members (event_id, user_id, role) VALUES ($1, $2, $3)`,
          [event.id, created_by, "creator"]
        );

        await client.query("COMMIT");
        res.json(event);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("Error creating event:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // === Update Event (PUT) ===
  router.put("/events/:id", ensureAuthenticated, async (req, res) => {
    try {
      if (req.user.role !== "manager") {
        return res.status(403).json({ error: "Only managers can update events" });
      }

      const eventId = req.params.id;
      const userId = req.user.id;

      // Check if the manager is a team member of this event
      const isMember = await checkTeamMembership(eventId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "You are not a team member of this event" });
      }

      const {
        title,
        description,
        organisation_id,
        category_id,
        currency,
        support_contact,
        support_contact_country_code,
        support_contact_phone,
        bid_manager_name,
        bid_manager,
        bid_manager_country_code,
        bid_manager_phone,
        auction_time,
        type,
        auction_duration,
        extension_time,
        extension_threshold,
      } = req.body;

      const auctionDurationInterval = normalizeInterval(auction_duration, "minutes");
      const extensionTimeInterval = normalizeInterval(extension_time, "seconds");
      const extensionThresholdInterval = normalizeInterval(extension_threshold, "seconds");

      const result = await pool.query(
        `UPDATE events 
         SET title = $1, 
             description = $2, 
             organisation_id = $3, 
             category_id = $4, 
             currency = $5, 
             support_contact = $6, 
             support_contact_country_code = $7,
             support_contact_phone = $8,
             bid_manager_name = $9,
             bid_manager = $10, 
             bid_manager_country_code = $11,
             bid_manager_phone = $12,
             auction_time = $13, 
             type = $14,
             auction_duration = $15,
             extension_time = $16,
             extension_threshold = $17
         WHERE id = $18
         RETURNING *`,
        [
          title,
          description,
          organisation_id,
          category_id,
          currency,
          support_contact,
          support_contact_country_code,
          support_contact_phone,
          bid_manager_name,
          bid_manager,
          bid_manager_country_code,
          bid_manager_phone,
          auction_time,
          type || "open",
          auctionDurationInterval,
          extensionTimeInterval,
          extensionThresholdInterval,
          eventId,
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

  // === Get All Events ===
  router.get("/events", ensureAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      const userRole = req.user.role;

      let query;
      let params;

      if (userRole === "manager") {
        // For managers, only return events where they are a team member (creator or participant)
        query = `
          SELECT DISTINCT e.*, 
                 o.name AS organisation_name, 
                 c.name AS category_name,
                 ROUND(EXTRACT(EPOCH FROM e.auction_duration) / 60)::int AS auction_duration,
                 ROUND(EXTRACT(EPOCH FROM e.extension_time))::int AS extension_time,
                 ROUND(EXTRACT(EPOCH FROM e.extension_threshold))::int AS extension_threshold
          FROM events e
          LEFT JOIN organisations o ON e.organisation_id = o.id
          LEFT JOIN categories c ON e.category_id = c.id
          INNER JOIN event_members em ON e.id = em.event_id
          WHERE em.user_id = $1 AND em.role IN ('creator', 'participant')
          ORDER BY e.auction_time ASC NULLS LAST, e.created_at DESC
        `;
        params = [userId];
      } else {
        // For bidders, return all events (or filter as needed)
        query = `
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
        `;
        params = [];
      }

      const result = await pool.query(query, params);
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

      const event = eventResult.rows[0];

      // Load line items for this event
      const lineItemsResult = await pool.query(
        `SELECT li.*, l.title AS lot_title
         FROM lots l
         JOIN line_items li ON li.lot_id = l.id
         WHERE l.event_id = $1
         ORDER BY l.id, li.id`,
        [req.params.id]
      );
      event.line_items = lineItemsResult.rows;

      // Load supplier assignments (with opening bids and weightings)
      const supplierAssignmentsResult = await pool.query(
        `SELECT 
           s.supplier_id,
           s.line_item_id,
           s.weighting,
           s.opening_bid,
           u.first_name,
           u.last_name,
           u.email
         FROM supplier_line_item_settings s
         JOIN users u ON s.supplier_id = u.id
         WHERE s.event_id = $1
         ORDER BY s.supplier_id, s.line_item_id`,
        [req.params.id]
      );
      event.supplier_assignments = supplierAssignmentsResult.rows.map(s => ({
        ...s,
        supplier_name: `${(s.first_name || '').trim()} ${(s.last_name || '').trim()}`.trim() || s.email || `Supplier ${s.supplier_id}`
      }));

      res.json(event);
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

      const eventId = req.params.id;
      const userId = req.user.id;

      // Check if the manager is a team member of this event
      const isMember = await checkTeamMembership(eventId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "You are not a team member of this event" });
      }

      await pool.query("UPDATE events SET reveal_bidders = TRUE WHERE id=$1", [eventId]);
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
          b.user_id, 
          u.first_name, 
          u.last_name, 
          u.email,
          COALESCE(s.weighting, 1.0) AS weighting
        FROM bids b
        LEFT JOIN users u ON b.user_id = u.id
        LEFT JOIN supplier_line_item_settings s ON s.event_id = b.event_id 
          AND s.line_item_id = b.line_item_id 
          AND s.supplier_id = b.user_id
        WHERE b.event_id = $1
        ORDER BY b.created_at DESC
      `;
      const bidsResult = await pool.query(bidsQuery, [eventId]);
      let bids = bidsResult.rows.map(b => ({
        ...b,
        bidder_id: b.user_id,
        user_name: `${(b.first_name || '').trim()} ${(b.last_name || '').trim()}`.trim() || b.email || `User ${b.user_id}`
      }));

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
        `SELECT e.auction_time, e.type, e.title, o.name AS organisation_name, c.name AS category_name
         FROM events e
         LEFT JOIN organisations o ON e.organisation_id = o.id
         LEFT JOIN categories c ON e.category_id = c.id
         WHERE e.id=$1`,
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
        title: event ? event.title : null,
        organisation_name: event ? event.organisation_name : null,
        category_name: event ? event.category_name : null,
      });
    } catch (err) {
      console.error("Error fetching stats:", err);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // === Get Event Members ===
  router.get("/events/:id/members", ensureAuthenticated, async (req, res) => {
    try {
      const eventId = req.params.id;
      
      const result = await pool.query(
        `SELECT em.user_id, em.role, u.email, u.first_name, u.last_name
         FROM event_members em
         JOIN users u ON em.user_id = u.id
         WHERE em.event_id = $1
         ORDER BY em.role, u.first_name`,
        [eventId]
      );

      res.json(result.rows);
    } catch (err) {
      console.error("Error fetching event members:", err);
      res.status(500).json({ error: "Failed to fetch event members" });
    }
  });

  // === Update Event Members ===
  router.post("/events/:id/members", ensureAuthenticated, async (req, res) => {
    try {
      if (req.user.role !== "manager") {
        return res.status(403).json({ error: "Only managers can update event members" });
      }

      const eventId = req.params.id;
      const userId = req.user.id;

      // Check if the manager is a team member of this event
      const isMember = await checkTeamMembership(eventId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "You are not a team member of this event" });
      }

      const { managers = [], bidders = [] } = req.body;

      // Start a transaction
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Get the event creator to preserve them
        const eventRes = await client.query("SELECT created_by FROM events WHERE id = $1", [eventId]);
        const creatorId = eventRes.rows[0]?.created_by;

        // Delete existing members (except creator if they exist)
        await client.query("DELETE FROM event_members WHERE event_id = $1", [eventId]);

        // Insert creator first if they exist (as 'creator' role)
        if (creatorId) {
          await client.query(
            "INSERT INTO event_members (event_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (event_id, user_id) DO NOTHING",
            [eventId, creatorId, "creator"]
          );
        }

        // Insert managers (as 'participant' role, since 'manager' is not allowed)
        for (const userId of managers) {
          if (userId !== creatorId) {
            await client.query(
              "INSERT INTO event_members (event_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (event_id, user_id) DO NOTHING",
              [eventId, userId, "participant"]
            );
          }
        }

        // Insert bidders
        for (const userId of bidders) {
          await client.query(
            "INSERT INTO event_members (event_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (event_id, user_id) DO NOTHING",
            [eventId, userId, "bidder"]
          );
        }

        await client.query("COMMIT");
        res.json({ success: true, message: "Members updated successfully" });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("Error updating event members:", err);
      res.status(500).json({ error: "Failed to update event members" });
    }
  });

  // === Delete Event ===
  router.delete("/events/:id", ensureAuthenticated, async (req, res) => {
    try {
      const eventId = req.params.id;
      const userId = req.user.id;

      // Only allow managers to delete events
      if (req.user.role !== "manager") {
        return res.status(403).json({ error: "Only managers can delete events" });
      }

      // Check if the manager is a team member of this event
      const isMember = await checkTeamMembership(eventId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "You are not a team member of this event" });
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