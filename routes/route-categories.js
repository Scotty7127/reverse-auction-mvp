// routes/route-categories.js
const express = require("express");
const { ensureAuthenticated } = require("../middleware/auth");

module.exports = (pool) => {
  const router = express.Router();

  // ---- Get all categories for an organisation ----
  router.get("/organisations/:orgId/categories", ensureAuthenticated, async (req, res) => {
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

  // ---- Create a new category under an organisation ----
  router.post("/organisations/:orgId/categories", ensureAuthenticated, async (req, res) => {
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

  // ---- Update category ----
  router.put("/categories/:id", ensureAuthenticated, async (req, res) => {
    try {
      const { name, description } = req.body;
      const result = await pool.query(
        `UPDATE categories
         SET name = $1, description = $2
         WHERE id = $3
         RETURNING *`,
        [name, description, req.params.id]
      );
      if (result.rows.length === 0)
        return res.status(404).json({ error: "Category not found" });
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error updating category:", err);
      res.status(500).send("Error updating category");
    }
  });

  // ---- Delete category ----
  router.delete("/categories/:id", ensureAuthenticated, async (req, res) => {
    try {
      await pool.query("DELETE FROM categories WHERE id = $1", [req.params.id]);
      res.sendStatus(204);
    } catch (err) {
      console.error("Error deleting category:", err);
      res.status(500).send("Error deleting category");
    }
  });

  return router;
};