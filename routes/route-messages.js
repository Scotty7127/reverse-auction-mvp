// routes/route-message.js
const express = require("express");
const { ensureAuthenticated } = require("../middleware/auth");
const pool = require("../db/pool");

const router = express.Router();

router.get("/users/:id/recent_chats", ensureAuthenticated, async (req, res) => {
  try {
    const userId = req.params.id;

    // Only allow a user or a manager to view their own recent chats
    if (req.user.role !== "manager" && req.user.id != userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const result = await pool.query(`
      SELECT
        sub.other_user_id,
        u.first_name,
        u.last_name,
        u.email,
        sub.last_message_time
      FROM (
        SELECT
          CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS other_user_id,
          MAX(created_at) AS last_message_time
        FROM messages
        WHERE sender_id = $1 OR receiver_id = $1
        GROUP BY other_user_id
      ) sub
      JOIN users u ON u.id = sub.other_user_id
      ORDER BY sub.last_message_time DESC;
    `, [userId]);

    res.json(result.rows);
  } catch (err) {
    console.error("Error getting recent chats:", err);
    res.status(500).json({ error: "Error getting recent chats" });
  }
});

router.get("/messages", ensureAuthenticated, async (req, res) => {
  try {
    const { user1, user2 } = req.query;
    if (!user1 || !user2) return res.status(400).json({ error: "Missing user IDs" });

    const result = await pool.query(`
      SELECT * FROM messages
      WHERE (sender_id = $1 AND receiver_id = $2)
         OR (sender_id = $2 AND receiver_id = $1)
      ORDER BY created_at ASC
    `, [user1, user2]);

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching messages (query):", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

router.get("/messages/latest", ensureAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(`
      SELECT
        CASE
          WHEN sender_id = $1 THEN receiver_id
          ELSE sender_id
        END AS other_user_id,
        MAX(created_at) AS latest_time
      FROM messages
      WHERE sender_id = $1 OR receiver_id = $1
      GROUP BY other_user_id
    `, [userId]);

    const map = {};
    for (const row of result.rows) map[row.other_user_id] = row.latest_time;
    res.json(map);
  } catch (err) {
    console.error("❌ /messages/latest failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/messages/:otherUserId", ensureAuthenticated, async (req, res) => {
  try {
    const { otherUserId } = req.params;
    const currentUserId = req.user.id;

    const result = await pool.query(`
      SELECT * FROM messages
      WHERE (sender_id = $1 AND receiver_id = $2)
         OR (sender_id = $2 AND receiver_id = $1)
      ORDER BY created_at ASC
    `, [currentUserId, otherUserId]);

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

router.post("/messages", ensureAuthenticated, async (req, res) => {
  try {
    const { receiver_id, content } = req.body;
    const sender_id = req.user.id;
    if (!receiver_id || !content.trim()) {
      return res.status(400).json({ error: "Receiver and content required" });
    }

    const result = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [sender_id, receiver_id, content]
    );

    const message = result.rows[0];
    io.to(`user_${receiver_id}`).emit("receive_message", message);
    res.json(message);
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

module.exports = (io) => {
  const jwt = require("jsonwebtoken");
  const SECRET = "supersecret"; // keep consistent with server.js
  io.on("connection", (socket) => {
    console.log("🔌 User connected to messaging");

    const token = socket.handshake.auth?.token;
    if (!token) {
      console.log("❌ Socket connection rejected: missing token");
      socket.disconnect();
      return;
    }

    try {
      const decoded = jwt.verify(token, SECRET);
      socket.user = decoded;
      socket.join(`user_${decoded.id}`);
      console.log(`✅ ${decoded.email} connected to messaging`);
    } catch (err) {
      console.error("❌ Invalid token:", err.message);
      socket.disconnect();
      return;
    }

    // Handle incoming messages
    socket.on("send_message", async (msg) => {
      try {
        const { toUserId, content } = msg || {};
        if (!toUserId || !content || !String(content).trim()) return;

        // Save to DB
        const insert = await pool.query(
          `INSERT INTO messages (sender_id, receiver_id, content)
           VALUES ($1, $2, $3)
           RETURNING id, sender_id, receiver_id, content, created_at, read`,
          [socket.user.id, toUserId, content.trim()]
        );
        const saved = insert.rows[0];

        // Emit to both users
        io.to(`user_${toUserId}`).emit("receive_message", saved);
        io.to(`user_${socket.user.id}`).emit("receive_message", saved);
        console.log("💬 Message saved & emitted:", saved);
      } catch (err) {
        console.error("❌ send_message error:", err);
      }
    });

    socket.on("disconnect", () => {
      console.log(`⚡️ ${socket.user?.email || "Unknown user"} disconnected`);
    });
  });

  return router;
};