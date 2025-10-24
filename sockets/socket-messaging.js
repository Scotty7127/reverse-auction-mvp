// sockets/socket-messaging.js
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");

module.exports = (io) => {
  const SECRET = process.env.JWT_SECRET || "supersecret";

  io.on("connection", (socket) => {
    console.log("🔌 User connected to messaging");

    // --- JWT Authentication ---
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

      // --- Core Messaging Events ---
      socket.on("send_message", async (msg) => {
        try {
          const { receiver_id, content } = msg || {};
          if (!receiver_id || !content) return;

          // Save message in DB
          const insert = await pool.query(
            `INSERT INTO messages (sender_id, receiver_id, content)
             VALUES ($1, $2, $3)
             RETURNING id, sender_id, receiver_id, content, created_at`,
            [socket.user.id, receiver_id, content]
          );
          const message = insert.rows[0];

          // Attach sender info
          const ures = await pool.query(
            `SELECT first_name, last_name, email FROM users WHERE id=$1`,
            [socket.user.id]
          );
          const u = ures.rows[0] || {};
          message.sender_name =
            `${(u.first_name || "").trim()} ${(u.last_name || "").trim()}`.trim() ||
            u.email ||
            `User ${socket.user.id}`;

          // Emit to receiver and sender rooms
          io.to(`user_${receiver_id}`).emit("new_message", message);
          socket.emit("message_sent", message);
        } catch (err) {
          console.error("💥 Error sending message:", err);
        }
      });

      // --- Auction / Event Real-Time Events ---
      socket.on("join_event", (eventId) => {
        if (!eventId) return;
        socket.join(`event_${eventId}`);
        console.log(`👥 ${socket.user.email} joined event ${eventId}`);
        io.to(`event_${eventId}`).emit("bidders_count_update");
      });

      socket.on("join_lot", (lotId) => {
        if (!lotId) return;
        socket.join(`lot_${lotId}`);
        console.log(`📦 ${socket.user.email} joined lot ${lotId}`);
      });

      socket.on("new_bid", async (data) => {
        try {
          const { event_id, line_item_id, amount } = data || {};
          if (!event_id || !amount || isNaN(Number(amount))) return;
          const user_id = socket.user.id;

          const insert = await pool.query(
            `INSERT INTO bids (event_id, user_id, line_item_id, amount)
             VALUES ($1, $2, $3, $4)
             RETURNING id, event_id, user_id, line_item_id, amount, created_at`,
            [event_id, user_id, line_item_id || null, amount]
          );
          const bid = insert.rows[0];

          const ures = await pool.query(
            `SELECT first_name, last_name, email FROM users WHERE id=$1`,
            [user_id]
          );
          const u = ures.rows[0] || {};
          bid.display_name =
            `${(u.first_name || "").trim()} ${(u.last_name || "").trim()}`.trim() ||
            u.email ||
            `User ${user_id}`;

          io.to(`event_${event_id}`).emit("bid_update", bid);
        } catch (err) {
          console.error("💥 Error saving bid:", err);
        }
      });

      // --- Disconnect ---
      socket.on("disconnect", () => {
        console.log(`⚡️ ${socket.user?.email || "Unknown user"} disconnected`);
      });
    } catch (err) {
      console.error("❌ Invalid token:", err.message);
      socket.disconnect();
      return;
    }
  });
};