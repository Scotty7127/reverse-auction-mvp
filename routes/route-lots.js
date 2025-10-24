// routes/route-lots.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const multer = require("multer");
const { ensureAuthenticated } = require("../middleware/auth");

module.exports = (pool) => {
  const router = express.Router();

  // ---- File Upload (Excel import only) ----
  const uploadDir = path.join(__dirname, "..", "uploads");
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, file.fieldname + "-" + Date.now() + ext);
    },
  });

  const upload = multer({ storage });

  // ---- LOT ROUTES ----

  // Get lots for an event
  router.get("/events/:id/lots", ensureAuthenticated, async (req, res) => {
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

  // Create a new lot
  router.post("/events/:id/lots", ensureAuthenticated, async (req, res) => {
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

  // Update a lot
  router.put("/lots/:id", ensureAuthenticated, async (req, res) => {
    try {
      const { title, description } = req.body;
      const result = await pool.query(
        `UPDATE lots SET title=$1, description=$2 WHERE id=$3 RETURNING *`,
        [title, description, req.params.id]
      );
      if (result.rows.length === 0)
        return res.status(404).json({ error: "Lot not found" });
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error updating lot:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get single lot
  router.get("/lots/:id", ensureAuthenticated, async (req, res) => {
    try {
      const result = await pool.query("SELECT * FROM lots WHERE id = $1", [req.params.id]);
      if (result.rows.length === 0)
        return res.status(404).json({ error: "Lot not found" });
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error fetching lot:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- LINE ITEMS ----

  // Get all line items for a lot
  router.get("/lots/:id/line-items", ensureAuthenticated, async (req, res) => {
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

  // Create a new line item
  router.post("/lots/:id/line-items", ensureAuthenticated, async (req, res) => {
    try {
      const body = { ...req.body };
      Object.keys(body).forEach((k) => {
        if (body[k] === "") body[k] = null;
      });

      const fields = [
        "lot_id", "item_number", "item_name", "group_number", "description", "quantity", "uom",
        "input", "required", "ties", "decimals", "decrement", "opening_value", "baseline",
        "ext_quantity", "ext_baseline", "reserve_value", "incumbent",
        "weighting_visible", "opening_visible", "reserve_visible",
      ];

      const values = [
        req.params.id, body.item_number, body.item_name, body.group_number, body.description,
        body.quantity, body.uom, body.input, body.required, body.ties, body.decimals, body.decrement,
        body.opening_value, body.baseline, body.ext_quantity, body.ext_baseline, body.reserve_value,
        body.incumbent, body.weighting_visible, body.opening_visible, body.reserve_visible,
      ];

      const result = await pool.query(
        `INSERT INTO line_items (${fields.join(",")})
         VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")})
         RETURNING *`,
        values
      );

      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error creating line item:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Update line item
  router.put("/line-items/:id", ensureAuthenticated, async (req, res) => {
    try {
      const body = { ...req.body };
      Object.keys(body).forEach((k) => {
        if (body[k] === "") body[k] = null;
      });

      const result = await pool.query(
        `UPDATE line_items SET
          item_number=$1, item_name=$2, group_number=$3, description=$4, quantity=$5, uom=$6,
          input=$7, required=$8, ties=$9, decimals=$10, decrement=$11, opening_value=$12,
          baseline=$13, ext_quantity=$14, ext_baseline=$15, reserve_value=$16, incumbent=$17,
          weighting_visible=$18, opening_visible=$19, reserve_visible=$20
         WHERE id=$21
         RETURNING *`,
        [
          body.item_number, body.item_name, body.group_number, body.description, body.quantity, body.uom,
          body.input, body.required, body.ties, body.decimals, body.decrement, body.opening_value,
          body.baseline, body.ext_quantity, body.ext_baseline, body.reserve_value, body.incumbent,
          body.weighting_visible, body.opening_visible, body.reserve_visible, req.params.id,
        ]
      );

      if (result.rows.length === 0)
        return res.status(404).json({ error: "Line item not found" });
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error updating line item:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Delete line item
  router.delete("/line-items/:id", ensureAuthenticated, async (req, res) => {
    try {
      const result = await pool.query(
        "DELETE FROM line_items WHERE id = $1 RETURNING *",
        [req.params.id]
      );
      if (result.rowCount === 0)
        return res.status(404).json({ error: "Line item not found" });
      res.json({ success: true });
    } catch (err) {
      console.error("Error deleting line item:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- SUPPLIER SETTINGS ----

  router.post("/events/:eventId/line-items/:lineItemId/supplier-settings", ensureAuthenticated, async (req, res) => {
    try {
      const { eventId, lineItemId } = req.params;
      const { supplier_id, weighting = 1.0, opening_bid = null } = req.body;

      const result = await pool.query(
        `
        INSERT INTO supplier_line_item_settings (event_id, line_item_id, supplier_id, weighting, opening_bid)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (event_id, line_item_id, supplier_id)
        DO UPDATE SET weighting=EXCLUDED.weighting, opening_bid=EXCLUDED.opening_bid
        RETURNING *;
        `,
        [eventId, lineItemId, supplier_id, weighting, opening_bid]
      );
      res.json(result.rows[0]);
    } catch (err) {
      console.error("Error upserting supplier settings:", err);
      res.status(500).json({ error: "Failed to save supplier settings" });
    }
  });

  router.get("/events/:eventId/line-items/:lineItemId/supplier-settings", ensureAuthenticated, async (req, res) => {
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
      console.error("Error fetching supplier settings:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- BIDDER ASSIGNMENTS ----

  router.get("/events/:eventId/bidders/:userId/line-items", ensureAuthenticated, async (req, res) => {
    try {
      const { eventId, userId } = req.params;
      if (req.user.role !== "manager" && req.user.id != userId)
        return res.status(403).json({ error: "Access denied" });

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

  router.post("/events/:eventId/bidders/:userId/line-items", ensureAuthenticated, async (req, res) => {
    try {
      const { eventId, userId } = req.params;
      const { assignedItemIds } = req.body;

      if (req.user.role !== "manager")
        return res.status(403).json({ error: "Access denied" });
      if (!Array.isArray(assignedItemIds))
        return res.status(400).json({ error: "Invalid data format" });

      await pool.query(`
        DELETE FROM bidder_item_assignments
        WHERE user_id = $1 AND line_item_id IN (
          SELECT li.id FROM line_items li
          JOIN lots l ON li.lot_id = l.id
          WHERE l.event_id = $2
        )
      `, [userId, eventId]);

      for (const itemId of assignedItemIds) {
        await pool.query(
          `INSERT INTO bidder_item_assignments (user_id, line_item_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [userId, itemId]
        );
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Error saving bidder assignments:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- EXCEL EXPORT ----

  router.get("/lots/:id/line-items/export", ensureAuthenticated, async (req, res) => {
    try {
      const lotId = req.params.id;
      const result = await pool.query(
        "SELECT * FROM line_items WHERE lot_id = $1 ORDER BY id ASC",
        [lotId]
      );

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Line Items");

      sheet.addRow([
        "Core Info", "", "", "", "", "", "",
        "Bid Settings", "", "", "", "", "",
        "Evaluative Settings", "", "", "", "",
        "Bid Interface Visibility", "", ""
      ]);
      sheet.addRow([
        "Item #", "Item Name", "Group #", "Description", "Qty", "UOM", "Extra",
        "Input", "Required", "Ties", ".00", "Decrement", "Opening",
        "Baseline", "Ext Qty", "Ext Base", "Reserve", "Incumbent",
        "Weighting", "Opening", "Reserve"
      ]);

      sheet.mergeCells("A1:G1");
      sheet.mergeCells("H1:M1");
      sheet.mergeCells("N1:R1");
      sheet.mergeCells("S1:U1");

      result.rows.forEach((r) => {
        sheet.addRow([
          r.item_number, r.item_name, r.group_number, r.description, r.quantity, r.uom, null,
          r.input, r.required, r.ties, r.decimals, r.decrement, r.opening_value,
          r.baseline, r.ext_quantity, r.ext_baseline, r.reserve_value, r.incumbent,
          r.weighting_visible, r.opening_visible, r.reserve_visible,
        ]);
      });

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="lot_${lotId}_line_items.xlsx"`);
      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error("Error exporting Excel:", err);
      res.status(500).send("Error exporting Excel");
    }
  });

  // ---- EXCEL IMPORT ----

  router.post("/lots/:id/line-items/import", upload.single("file"), async (req, res) => {
    const lotId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.readFile(req.file.path);
      const sheet = workbook.worksheets[0];
      const startRow = 3;

      for (let i = startRow; i <= sheet.rowCount; i++) {
        const row = sheet.getRow(i);
        if (!row || !row.getCell(1).value) continue;

        const values = row.values.slice(1, 22);
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
          [lotId, ...values]
        );
      }

      fs.unlinkSync(req.file.path);
      res.json({ success: true, message: "✅ Excel imported successfully" });
    } catch (err) {
      console.error("Error importing Excel:", err);
      res.status(500).json({ error: "Failed to import Excel" });
    }
  });

  return router;
};