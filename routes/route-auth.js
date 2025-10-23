// /routes/route-auth.js
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { ensureAuthenticated } = require("../middleware/auth");

const JWT_SECRET = "supersecret"; // you can pull this from process.env later

module.exports = (app, pool) => {
  // === Register a new user ===
  app.post("/register", async (req, res) => {
    try {
      const { first_name, last_name, email, password, organisation_id } = req.body;

      const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: "Email already registered" });
      }

      const password_hash = await bcrypt.hash(password, 10);

      const insert = await pool.query(
        `INSERT INTO users (first_name, last_name, email, password_hash, organisation_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, first_name, last_name, email, organisation_id`,
        [first_name, last_name, email, password_hash, organisation_id || null]
      );

      res.json(insert.rows[0]);
    } catch (err) {
      console.error("Error in /register:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // === Login ===
  app.post("/login", async (req, res) => {
    try {
      const { email, password } = req.body;

      const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
      if (result.rows.length === 0) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const user = result.rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: "12h" }
      );

      res.json({
        token,
        user: {
          id: user.id,
          first_name: user.first_name,
          last_name: user.last_name,
          email: user.email,
          organisation_id: user.organisation_id,
          role: user.role,
        },
      });
    } catch (err) {
      console.error("Error in /login:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // === Get current logged-in user ===
  app.get("/users/me", async (req, res) => {
    try {
      const auth = req.headers.authorization;
      if (!auth) return res.status(401).json({ error: "Missing token" });

      const token = auth.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      const user = await pool.query(
        `SELECT id, first_name, last_name, email, organisation_id, role FROM users WHERE id = $1`,
        [decoded.id]
      );

      if (user.rows.length === 0) return res.status(404).json({ error: "User not found" });

      res.json(user.rows[0]);
    } catch (err) {
      console.error("Error in /users/me:", err);
      res.status(401).json({ error: "Invalid or expired token" });
    }
  });
};