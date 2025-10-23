// /routes/route-messages.js
const { ensureAuthenticated } = require("../middleware/auth");

module.exports = (app, pool, io) => {
  // === Get messages for an event ===
  app.get("/messages/:eventId", ensureAuthenticated, async (req, res) => {
    try {
      const { eventId } = req.params;
      const messages = await pool.query(
        `SELECT m.*, u.first_name, u.last_name, o.name AS organisation_name
         FROM messages m
         LEFT JOIN users u ON m.user_id = u.id
         LEFT JOIN organisations o ON u.organisation_id = o.id
         WHERE m.event_id = $1
         ORDER BY m.created_at ASC`,
        [eventId]
      );
      res.json(messages.rows);
    } catch (err) {
      console.error("Error fetching messages:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // === Post new message to event ===
  app.post("/messages/:eventId", ensureAuthenticated, async (req, res) => {
    try {
      const { eventId } = req.params;
      const { text } = req.body;
      const userId = req.user.id;

      const result = await pool.query(
        `INSERT INTO messages (event_id, user_id, text)
         VALUES ($1, $2, $3)
         RETURNING id, event_id, user_id, text, created_at`,
        [eventId, userId, text]
      );

      const message = result.rows[0];
      const ures = await pool.query(
        `SELECT u.first_name, u.last_name, u.email, o.name AS organisation_name
         FROM users u
         LEFT JOIN organisations o ON u.organisation_id = o.id
         WHERE u.id = $1`,
        [userId]
      );

      const u = ures.rows[0] || {};
      message.display_name =
        u.organisation_name ||
        `${(u.first_name || "").trim()} ${(u.last_name || "").trim()}`.trim() ||
        u.email ||
        `User ${userId}`;

      // Broadcast message to all connected users in this event
      io.to(`event_${eventId}`).emit("new_message", message);

      res.json(message);
    } catch (err) {
      console.error("Error posting message:", err);
      res.status(500).json({ error: "Server error" });
    }
  });
};