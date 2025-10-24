// routes/route-static.js
const express = require("express");
const path = require("path");

module.exports = () => {
  const router = express.Router();

  // ---- Serve invite page ----
  router.get("/invite/:token", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "client", "invite.html"));
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