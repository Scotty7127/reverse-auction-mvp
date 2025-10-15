// config.js
window.apiBase = window.location.origin.includes("localhost")
  ? "http://localhost:4000"
  : window.location.origin;