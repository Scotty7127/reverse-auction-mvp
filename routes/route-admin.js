// routes/route-admin.js
const express = require("express");

module.exports = (pool) => {
  const router = express.Router();

  // === Clear all users and invitations for testing ===
  router.post("/admin/clear-test-data", async (req, res) => {
    try {
      await pool.query("TRUNCATE TABLE invitations RESTART IDENTITY CASCADE;");
      await pool.query("TRUNCATE TABLE users RESTART IDENTITY CASCADE;");
      res.json({
        success: true,
        message: "All users and invitations cleared."
      });
    } catch (err) {
      console.error("Error clearing test data:", err);
      res.status(500).json({ error: "Failed to clear test data" });
    }
  });

  return router;
};