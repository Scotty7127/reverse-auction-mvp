// routes/route-rfqs.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { ensureAuthenticated } = require("../middleware/auth");
const { checkTeamMembership } = require("../middleware/team-access");

module.exports = (pool) => {
  const router = express.Router();

  // ---- File Upload Setup ----
  const uploadDir = path.join(__dirname, "..", "uploads", "rfq-documents");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname);
      cb(null, "rfq-doc-" + uniqueSuffix + ext);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
    fileFilter: (req, file, cb) => {
      // Allow common document types
      const allowedMimes = [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain',
        'image/jpeg',
        'image/png',
        'image/gif',
        'application/zip',
        'application/x-zip-compressed'
      ];
      
      if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Invalid file type. Only documents, images, and PDFs are allowed.'));
      }
    }
  });

  // ---- Get current RFQ for an event ----
  router.get("/events/:eventId/rfq", ensureAuthenticated, async (req, res) => {
    try {
      const { eventId } = req.params;
      
      const result = await pool.query(
        "SELECT * FROM rfqs WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1",
        [eventId]
      );
      
      if (result.rows.length === 0) {
        return res.json(null);
      }
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error fetching RFQ:", err);
      res.status(500).json({ error: "Failed to fetch RFQ" });
    }
  });

  // ---- Save or update RFQ instructions ----
  router.post("/events/:eventId/rfq", ensureAuthenticated, async (req, res) => {
    try {
      if (req.user.role !== "manager") {
        return res.status(403).json({ error: "Only managers can save RFQs" });
      }

      const eventId = parseInt(req.params.eventId);
      const { info, rich_text_content, publish_time, clarification_deadline, deadline_time, reminder_time } = req.body;

      // Check if RFQ already exists
      const existingRFQ = await pool.query(
        `SELECT id FROM rfqs WHERE event_id = $1`,
        [eventId]
      );

      let result;
      if (existingRFQ.rows.length > 0) {
        // Update existing RFQ
        result = await pool.query(
          `UPDATE rfqs 
           SET info = $1, 
               rich_text_content = $2, 
               publish_time = $3, 
               clarification_deadline = $4,
               deadline_time = $5, 
               reminder_time = $6,
               published = FALSE,
               published_date = NULL,
               updated_at = NOW()
           WHERE event_id = $7
           RETURNING *`,
          [info, rich_text_content, publish_time, clarification_deadline, deadline_time, reminder_time, eventId]
        );
      } else {
        // Create new RFQ
        result = await pool.query(
          `INSERT INTO rfqs (event_id, info, rich_text_content, publish_time, clarification_deadline, deadline_time, reminder_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [eventId, info, rich_text_content, publish_time, clarification_deadline, deadline_time, reminder_time]
        );
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error saving RFQ:", err);
      res.status(500).json({ error: "Failed to save RFQ" });
    }
  });

  // ---- Publish RFQ ----
  router.post("/events/:eventId/rfq/publish", ensureAuthenticated, async (req, res) => {
    try {
      if (req.user.role !== "manager") {
        return res.status(403).json({ error: "Only managers can publish RFQs" });
      }

      const { eventId } = req.params;
      const userId = req.user.id;

      // Check if the manager is a team member of this event
      const isMember = await checkTeamMembership(eventId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "You are not a team member of this event" });
      }

      const {
        info,
        rich_text_content,
        publish_time,
        clarification_deadline,
        deadline_time,
        reminder_time,
      } = req.body;

      if (!publish_time) {
        return res.status(400).json({ error: "Publish time is required" });
      }

      // Check if RFQ already exists
      const existing = await pool.query(
        "SELECT id FROM rfqs WHERE event_id = $1",
        [eventId]
      );

      let result;
      // Set published to true and record when it was set to publish (not when it will actually publish)
      if (existing.rows.length > 0) {
        // Update and set to publish existing RFQ
        result = await pool.query(
          `UPDATE rfqs 
           SET info = $1, 
               rich_text_content = $2, 
               publish_time = $3,
               clarification_deadline = $4,
               deadline_time = $5, 
               reminder_time = $6,
               published = TRUE,
               published_date = NOW(),
               updated_at = NOW()
           WHERE event_id = $7
           RETURNING *`,
          [info, rich_text_content, publish_time, clarification_deadline, deadline_time, reminder_time, eventId]
        );
      } else {
        // Create and set to publish new RFQ
        result = await pool.query(
          `INSERT INTO rfqs (event_id, info, rich_text_content, publish_time, clarification_deadline, deadline_time, reminder_time, published, published_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW())
           RETURNING *`,
          [eventId, info, rich_text_content, publish_time, clarification_deadline, deadline_time, reminder_time]
        );
      }

      // TODO: Schedule notification to bidders at publish_time
      // TODO: Schedule reminder at reminder_time
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error publishing RFQ:", err);
      res.status(500).json({ error: "Failed to publish RFQ" });
    }
  });

  // ---- Get past RFQs from same organisation and category ----
  router.get("/events/:eventId/rfq/past", ensureAuthenticated, async (req, res) => {
    try {
      if (req.user.role !== "manager") {
        return res.status(403).json({ error: "Only managers can view past RFQs" });
      }

      const { eventId } = req.params;

      // Get the organisation_id and category_id for the current event
      const eventResult = await pool.query(
        "SELECT organisation_id, category_id FROM events WHERE id = $1",
        [eventId]
      );

      if (eventResult.rows.length === 0) {
        return res.status(404).json({ error: "Event not found" });
      }

      const { organisation_id, category_id } = eventResult.rows[0];

      // Get all published RFQs from events with same org and category (excluding current event)
      const result = await pool.query(
        `SELECT r.*, e.title AS event_title, e.created_at AS event_created_at
         FROM rfqs r
         JOIN events e ON r.event_id = e.id
         WHERE e.organisation_id = $1 
         AND e.category_id = $2 
         AND r.event_id != $3
         AND r.published = TRUE
         ORDER BY r.published_date DESC
         LIMIT 50`,
        [organisation_id, category_id, eventId]
      );

      res.json(result.rows);
    } catch (err) {
      console.error("Error fetching past RFQs:", err);
      res.status(500).json({ error: "Failed to fetch past RFQs" });
    }
  });

  // ---- Upload RFQ attachment ----
  router.post("/events/:eventId/rfq/attachments", ensureAuthenticated, upload.single("document"), async (req, res) => {
    try {
      if (req.user.role !== "manager") {
        return res.status(403).json({ error: "Only managers can upload attachments" });
      }

      const { eventId } = req.params;
      const userId = req.user.id;

      // Check if the manager is a team member of this event
      const isMember = await checkTeamMembership(eventId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "You are not a team member of this event" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      // Get or create RFQ for this event
      let rfqResult = await pool.query("SELECT id FROM rfqs WHERE event_id = $1", [eventId]);
      let rfqId;

      if (rfqResult.rows.length === 0) {
        // Create a placeholder RFQ if it doesn't exist
        const newRFQ = await pool.query(
          "INSERT INTO rfqs (event_id) VALUES ($1) RETURNING id",
          [eventId]
        );
        rfqId = newRFQ.rows[0].id;
      } else {
        rfqId = rfqResult.rows[0].id;
      }

      // Save attachment info to database - use the full path from multer
      const result = await pool.query(
        `INSERT INTO rfq_attachments (rfq_id, event_id, filename, original_filename, file_path, file_size, mime_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [rfqId, eventId, req.file.filename, req.file.originalname, req.file.path, req.file.size, req.file.mimetype]
      );

      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error uploading attachment:", err);
      // Clean up file if database insert fails
      if (req.file) {
        fs.unlinkSync(req.file.path).catch(() => {});
      }
      res.status(500).json({ error: "Failed to upload attachment" });
    }
  });

  // ---- Get RFQ attachments ----
  router.get("/events/:eventId/rfq/attachments", ensureAuthenticated, async (req, res) => {
    try {
      const { eventId } = req.params;

      const result = await pool.query(
        `SELECT * FROM rfq_attachments 
         WHERE event_id = $1 
         ORDER BY uploaded_at DESC`,
        [eventId]
      );

      res.json(result.rows);
    } catch (err) {
      console.error("Error fetching attachments:", err);
      res.status(500).json({ error: "Failed to fetch attachments" });
    }
  });

  // ---- Download RFQ attachment ----
  router.get("/events/:eventId/rfq/attachments/:attachmentId/download", ensureAuthenticated, async (req, res) => {
    try {
      const { eventId, attachmentId } = req.params;

      const result = await pool.query(
        `SELECT * FROM rfq_attachments 
         WHERE id = $1 AND event_id = $2`,
        [attachmentId, eventId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Attachment not found" });
      }

      const attachment = result.rows[0];
      res.download(attachment.file_path, attachment.original_filename);
    } catch (err) {
      console.error("Error downloading attachment:", err);
      res.status(500).json({ error: "Failed to download attachment" });
    }
  });

  // ---- Delete RFQ attachment ----
  router.delete("/events/:eventId/rfq/attachments/:attachmentId", ensureAuthenticated, async (req, res) => {
    try {
      if (req.user.role !== "manager") {
        return res.status(403).json({ error: "Only managers can delete attachments" });
      }

      const { eventId, attachmentId } = req.params;
      const userId = req.user.id;

      // Check if the manager is a team member of this event
      const isMember = await checkTeamMembership(eventId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "You are not a team member of this event" });
      }

      // Get attachment info
      const result = await pool.query(
        "SELECT * FROM rfq_attachments WHERE id = $1 AND event_id = $2",
        [attachmentId, eventId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Attachment not found" });
      }

      const attachment = result.rows[0];

      // Delete file from filesystem
      const fullPath = path.join(__dirname, "..", "uploads", "rfq-documents", attachment.filename);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }

      // Delete from database
      await pool.query("DELETE FROM rfq_attachments WHERE id = $1", [attachmentId]);

      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting attachment:", err);
      res.status(500).json({ error: "Failed to delete attachment" });
    }
  });

  return router;
};
