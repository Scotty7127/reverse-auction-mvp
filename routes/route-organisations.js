// routes/route-organisations.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { ensureAuthenticated } = require("../middleware/auth");

module.exports = (pool) => {
  const router = express.Router();

  // --- Get all users for an organisation ---
  router.get("/organisations/:id/users", ensureAuthenticated, async (req, res) => {
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

  // --- Add existing user to organisation ---
  router.patch("/organisations/:id/members/:userId", ensureAuthenticated, async (req, res) => {
    try {
      const { id: orgId, userId } = req.params;

      // Check if organisation exists
      const orgCheck = await pool.query("SELECT id FROM organisations WHERE id = $1", [orgId]);
      if (orgCheck.rows.length === 0) {
        return res.status(404).json({ error: "Organisation not found" });
      }

      // Check if user exists
      const userCheck = await pool.query("SELECT id, email FROM users WHERE id = $1", [userId]);
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      // Update user's organisation
      const result = await pool.query(
        `UPDATE users SET organisation_id = $1 WHERE id = $2
         RETURNING id, first_name, last_name, email, role, organisation_id`,
        [orgId, userId]
      );

      res.json({
        message: "User added to organisation successfully",
        user: result.rows[0]
      });
    } catch (err) {
      console.error("Error adding user to organisation:", err);
      res.status(500).json({ error: "Failed to add user to organisation" });
    }
  });

  // --- Remove user from organisation ---
  router.delete("/organisations/:id/members/:userId", ensureAuthenticated, async (req, res) => {
    try {
      const { id: orgId, userId } = req.params;

      // Update user's organisation to NULL
      const result = await pool.query(
        `UPDATE users SET organisation_id = NULL WHERE id = $1 AND organisation_id = $2
         RETURNING id`,
        [userId, orgId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "User not found in this organisation" });
      }

      res.json({ message: "User removed from organisation successfully" });
    } catch (err) {
      console.error("Error removing user from organisation:", err);
      res.status(500).json({ error: "Failed to remove user from organisation" });
    }
  });

  // ---- Multer setup (local upload dir) ----
  const uploadDir = path.join(__dirname, "..", "uploads");
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const filename = file.fieldname + "-" + Date.now() + ext;
      cb(null, filename);
    },
  });

  const upload = multer({ storage });

  // ---- GET all organisations ----
  router.get("/organisations", ensureAuthenticated, async (req, res) => {
    try {
      const rawType = (req.query.type || "").toString().trim().toLowerCase();
      const allowedTypes = ["client", "agency", "supplier"];

      if (allowedTypes.includes(rawType)) {
        const result = await pool.query(
          "SELECT * FROM organisations WHERE type = $1 ORDER BY created_at DESC",
          [rawType]
        );
        return res.json(result.rows);
      }

      if (req.query.type !== undefined) {
        return res.json([]); // invalid filter type → return empty
      }

      const result = await pool.query(
        "SELECT * FROM organisations ORDER BY created_at DESC"
      );
      res.json(result.rows);
    } catch (err) {
      console.error("Error fetching organisations:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- GET organisation by ID ----
  router.get("/organisations/:id", async (req, res) => {
    try {
      const result = await pool.query("SELECT * FROM organisations WHERE id = $1", [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: "Organisation not found" });
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error fetching organisation:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- CREATE new organisation ----
  router.post("/organisations", upload.single("logo"), async (req, res) => {
    try {
      const { name, currency, type } = req.body;
      const rawType = (type || "client").toString().trim().toLowerCase();
      const allowedTypes = ["client", "agency", "supplier"];
      const safeType = allowedTypes.includes(rawType) ? rawType : "client";

      let logo_url = null;
      if (req.file) {
        logo_url = `/uploads/${req.file.filename}`;
      }

      if (!name) return res.status(400).json({ error: "Name is required" });

      const result = await pool.query(
        `INSERT INTO organisations (name, currency, logo_url, type)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [name, currency || null, logo_url, safeType]
      );

      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error creating organisation:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- UPDATE organisation ----
  router.put("/organisations/:id", upload.single("logo"), async (req, res) => {
    try {
      const { name, currency, type } = req.body;

      const existing = await pool.query("SELECT * FROM organisations WHERE id = $1", [req.params.id]);
      if (existing.rows.length === 0) return res.status(404).json({ error: "Organisation not found" });

      const existingOrg = existing.rows[0];
      let logo_url = existingOrg.logo_url;

      if (req.file) {
        logo_url = `/uploads/${req.file.filename}`;
        if (existingOrg.logo_url) {
          const oldLogoPath = path.join(__dirname, "..", existingOrg.logo_url);
          fs.unlink(oldLogoPath, (err) => {
            if (err) console.error("Error deleting old logo:", err);
          });
        }
      }

      const rawType = ((type ?? existingOrg.type) ?? "client").toString().trim().toLowerCase();
      const allowedTypes = ["client", "agency", "supplier"];
      const safeType = allowedTypes.includes(rawType) ? rawType : existingOrg.type;

      const result = await pool.query(
        `UPDATE organisations
         SET name=$1, currency=$2, logo_url=$3, type=$4
         WHERE id=$5
         RETURNING *`,
        [name || existingOrg.name, currency || existingOrg.currency, logo_url, safeType, req.params.id]
      );

      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error updating organisation:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- DELETE organisation ----
  router.delete("/organisations/:id", async (req, res) => {
    try {
      const existing = await pool.query("SELECT * FROM organisations WHERE id = $1", [req.params.id]);
      if (existing.rows.length === 0) return res.status(404).json({ error: "Organisation not found" });

      const org = existing.rows[0];
      if (org.logo_url) {
        const logoPath = path.join(__dirname, "..", org.logo_url);
        fs.unlink(logoPath, (err) => {
          if (err) console.error("Error deleting logo:", err);
        });
      }

      await pool.query("DELETE FROM events WHERE organisation_id = $1", [req.params.id]);
      await pool.query("DELETE FROM organisations WHERE id = $1", [req.params.id]);

      res.json({ success: true, message: "Organisation and related events deleted" });
    } catch (err) {
      console.error("Error deleting organisation:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};