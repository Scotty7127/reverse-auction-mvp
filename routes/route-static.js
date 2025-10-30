// routes/route-static.js
const express = require("express");
const path = require("path");
const jwt = require("jsonwebtoken");

module.exports = () => {
  const router = express.Router();
  const JWT_SECRET = process.env.SECRET || "supersecret";

  // ---- Root route - smart redirect based on auth status ----
  router.get("/", (req, res) => {
    const auth = req.headers.authorization;
    const token = req.cookies?.token || (auth && auth.split(" ")[1]);

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        // Valid token - redirect to appropriate dashboard based on role
        if (decoded.role === "manager") {
          return res.redirect("/manager.html");
        } else if (decoded.role === "bidder") {
          return res.redirect("/bidder.html");
        }
      } catch (err) {
        // Invalid/expired token - redirect to login
      }
    }
    // No token or invalid - redirect to login
    res.redirect("/start.html");
  });

  // ---- Serve invite page ----
  router.get("/invite/:token", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "client", "invite.html"));
  });

  // ---- Serve password reset page ----
  router.get("/reset-password/:token", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "client", "reset-password.html"));
  });

  // ---- Serve start (login) page ----
  router.get("/start.html", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "client", "start.html"));
  });

  // ---- Serve manager dashboard ----
  router.get("/manager.html", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "client", "manager.html"));
  });

  // ---- Serve bidder dashboard ----
  router.get("/bidder.html", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "client", "bidder.html"));
  });

  // ---- Serve bidder account page ----
  router.get("/bidderaccount.html", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "client", "bidderaccount.html"));
  });

  return router;
};