// /middleware/auth.js
const jwt = require("jsonwebtoken");
const JWT_SECRET = "supersecret"; // TODO: move to process.env.JWT_SECRET later

// Middleware to protect routes that require authentication
function ensureAuthenticated(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Missing token" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // make the user info available to the route
    next(); // move on to the next step (the route)
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = { ensureAuthenticated };