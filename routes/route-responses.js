const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs").promises;
const { ensureAuthenticated } = require("../middleware/auth");
const { checkTeamMembership } = require("../middleware/team-access");

// Configure multer for response attachments
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const dir = path.join(__dirname, "../uploads/rfq-responses");
    await fs.mkdir(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "image/jpeg",
      "image/png",
      "image/gif",
      "text/plain",
      "application/zip",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type"));
    }
  },
});

module.exports = (pool) => {
  const router = express.Router();
  
  // Get all responses for an event (managers only)
  router.get(
    "/events/:eventId/responses",
    ensureAuthenticated,
    async (req, res) => {
      const { eventId } = req.params;
      const userId = req.user.id;

      try {
        // Check team membership
        const isMember = await checkTeamMembership(eventId, userId);
        if (!isMember) {
          return res.status(403).json({ error: "Not a team member" });
        }

        const result = await pool.query(
          `
          SELECT 
            rr.id,
            rr.event_id,
            rr.user_id,
            rr.response_text,
            rr.status,
            rr.review_notes,
            rr.reviewed_by,
            rr.reviewed_at,
            rr.submitted_at,
            u.name AS bidder_name,
            u.email AS bidder_email,
            o.name AS bidder_org,
            (SELECT COUNT(*) FROM rfq_response_attachments WHERE response_id = rr.id) AS attachment_count
          FROM rfq_responses rr
          LEFT JOIN users u ON rr.user_id = u.id
          LEFT JOIN organisations o ON u.organisation_id = o.id
          WHERE rr.event_id = $1
          ORDER BY rr.submitted_at DESC
          `,
          [eventId]
        );
        res.json(result.rows);
      } catch (err) {
        console.error("Error fetching responses:", err);
        res.status(500).json({ error: "Failed to fetch responses" });
      }
    }
  );

  // Get a specific response
  router.get(
    "/events/:eventId/responses/:responseId",
    ensureAuthenticated,
    async (req, res) => {
      const { eventId, responseId } = req.params;
      try {
        const result = await pool.query(
          `
          SELECT 
            rr.*,
            u.name AS bidder_name,
            u.email AS bidder_email,
            o.name AS bidder_org
          FROM rfq_responses rr
          LEFT JOIN users u ON rr.user_id = u.id
          LEFT JOIN organisations o ON u.organisation_id = o.id
          WHERE rr.id = $1 AND rr.event_id = $2
          `,
          [responseId, eventId]
        );
        if (result.rows.length === 0) {
          return res.status(404).json({ error: "Response not found" });
        }
        res.json(result.rows[0]);
      } catch (err) {
        console.error("Error fetching response:", err);
        res.status(500).json({ error: "Failed to fetch response" });
      }
    }
  );

  // Submit a response (bidders)
  // Submit a response (bidders)
  router.post(
    "/events/:eventId/responses",
    ensureAuthenticated,
    async (req, res) => {
      const { eventId } = req.params;
      const { response_text } = req.body;
      const userId = req.user.id;

      try {
        // Check if response already exists
        const existing = await pool.query(
          "SELECT id FROM rfq_responses WHERE event_id = $1 AND user_id = $2",
          [eventId, userId]
        );

        if (existing.rows.length > 0) {
          // Update existing response
          const result = await pool.query(
            `
            UPDATE rfq_responses 
            SET response_text = $1, submitted_at = NOW(), status = 'pending'
            WHERE event_id = $2 AND user_id = $3
            RETURNING *
            `,
            [response_text, eventId, userId]
          );
          return res.json(result.rows[0]);
        } else {
          // Create new response
          const result = await pool.query(
            `
            INSERT INTO rfq_responses (event_id, user_id, response_text)
            VALUES ($1, $2, $3)
            RETURNING *
            `,
            [eventId, userId, response_text]
          );
          return res.json(result.rows[0]);
        }
      } catch (err) {
        console.error("Error submitting response:", err);
        res.status(500).json({ error: "Failed to submit response" });
      }
    }
  );

  // Review a response (managers only)
  router.post(
    "/events/:eventId/responses/:responseId/review",
    ensureAuthenticated,
    async (req, res) => {
      const { eventId, responseId } = req.params;
      const { status, review_notes } = req.body;
      const reviewerId = req.user.id;

      if (!["approved", "rejected"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      try {
        // Check team membership
        const isMember = await checkTeamMembership(eventId, reviewerId);
        if (!isMember) {
          return res.status(403).json({ error: "Not a team member" });
        }

        const result = await pool.query(
          `
          UPDATE rfq_responses 
          SET status = $1, review_notes = $2, reviewed_by = $3, reviewed_at = NOW()
          WHERE id = $4 AND event_id = $5
          RETURNING *
          `,
          [status, review_notes, reviewerId, responseId, eventId]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "Response not found" });
        }

        // TODO: Send notification to bidder about approval/rejection

        res.json(result.rows[0]);
      } catch (err) {
        console.error("Error reviewing response:", err);
        res.status(500).json({ error: "Failed to review response" });
      }
    }
  );

  // Upload attachment for response
  // Upload attachment for response
  router.post(
    "/events/:eventId/responses/:responseId/attachments",
    ensureAuthenticated,
    upload.single("file"),
    async (req, res) => {
      const { eventId, responseId } = req.params;
      const userId = req.user.id;

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      try {
        // Verify the response belongs to the user (or user is a manager)
        const responseCheck = await pool.query(
          "SELECT user_id FROM rfq_responses WHERE id = $1 AND event_id = $2",
          [responseId, eventId]
        );

        if (responseCheck.rows.length === 0) {
          return res.status(404).json({ error: "Response not found" });
        }

        // Check if user owns the response or is a manager
        if (responseCheck.rows[0].user_id !== userId) {
          const teamCheck = await pool.query(
            `SELECT 1 FROM event_teams WHERE event_id = $1 AND user_id = $2`,
            [eventId, userId]
          );
          if (teamCheck.rows.length === 0) {
            return res.status(403).json({ error: "Unauthorized" });
          }
        }

        const result = await pool.query(
          `
          INSERT INTO rfq_response_attachments 
          (response_id, event_id, filename, original_filename, file_path, file_size, mime_type)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *
          `,
          [
            responseId,
            eventId,
            req.file.filename,
            req.file.originalname,
            req.file.path,
            req.file.size,
            req.file.mimetype,
          ]
        );

        res.json(result.rows[0]);
      } catch (err) {
        console.error("Error uploading attachment:", err);
        res.status(500).json({ error: "Failed to upload attachment" });
      }
    }
  );

  // Get attachments for a response
  router.get(
    "/events/:eventId/responses/:responseId/attachments",
    ensureAuthenticated,
    async (req, res) => {
      const { eventId, responseId } = req.params;
      try {
        const result = await pool.query(
          `
          SELECT * FROM rfq_response_attachments
          WHERE response_id = $1 AND event_id = $2
          ORDER BY uploaded_at DESC
          `,
          [responseId, eventId]
        );
        res.json(result.rows);
      } catch (err) {
        console.error("Error fetching attachments:", err);
        res.status(500).json({ error: "Failed to fetch attachments" });
      }
    }
  );

  // Download attachment
  router.get(
    "/events/:eventId/responses/:responseId/attachments/:attachmentId/download",
    ensureAuthenticated,
    async (req, res) => {
      const { eventId, responseId, attachmentId } = req.params;
      try {
        const result = await pool.query(
          `
          SELECT * FROM rfq_response_attachments
          WHERE id = $1 AND response_id = $2 AND event_id = $3
          `,
          [attachmentId, responseId, eventId]
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
    }
  );

  // Delete attachment
  router.delete(
    "/events/:eventId/responses/:responseId/attachments/:attachmentId",
    ensureAuthenticated,
    async (req, res) => {
      const { eventId, responseId, attachmentId } = req.params;
      const userId = req.user.id;

      try {
        // Verify ownership
        const responseCheck = await pool.query(
          "SELECT user_id FROM rfq_responses WHERE id = $1 AND event_id = $2",
          [responseId, eventId]
        );

        if (responseCheck.rows.length === 0) {
          return res.status(404).json({ error: "Response not found" });
        }

        if (responseCheck.rows[0].user_id !== userId) {
          const teamCheck = await pool.query(
            `SELECT 1 FROM event_teams WHERE event_id = $1 AND user_id = $2`,
            [eventId, userId]
          );
          if (teamCheck.rows.length === 0) {
            return res.status(403).json({ error: "Unauthorized" });
          }
        }

        const result = await pool.query(
          `
          DELETE FROM rfq_response_attachments
          WHERE id = $1 AND response_id = $2 AND event_id = $3
          RETURNING file_path
          `,
          [attachmentId, responseId, eventId]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "Attachment not found" });
        }

        // Delete the file from filesystem
        try {
          await fs.unlink(result.rows[0].file_path);
        } catch (err) {
          console.error("Error deleting file:", err);
        }

        res.json({ message: "Attachment deleted" });
      } catch (err) {
        console.error("Error deleting attachment:", err);
        res.status(500).json({ error: "Failed to delete attachment" });
      }
    }
  );

  return router;
};
