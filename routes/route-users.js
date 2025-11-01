// routes/route-users.js
const express = require("express");
const { ensureAuthenticated } = require("../middleware/auth");

module.exports = (pool) => {
  const router = express.Router();

  // Get all users (for assigning members)
  router.get("/users", ensureAuthenticated, async (req, res) => {
    try {
      const { excludeOrgId } = req.query;

      let query = `
        SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.organisation_id, o.name AS organisation_name
        FROM users u
        LEFT JOIN organisations o ON u.organisation_id = o.id
      `;

      let params = [];

      if (excludeOrgId) {
        query += ` WHERE (u.organisation_id IS NULL OR u.organisation_id != $1)`;
        params.push(excludeOrgId);
      }

      query += ` ORDER BY u.first_name ASC`;

      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      console.error("Error fetching users:", err);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  return router;
};