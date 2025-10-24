// Lightweight JWT decoder for browser use
if (!window.jwt_decode) {
  window.jwt_decode = function (token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error("Invalid token");
    const payload = parts[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  };
}
// auth.js — shared authentication check for manager pages
// Uses global apiBase defined in config.js
// Helper: fetch with Authorization header
window.authFetch = function(url, options = {}) {
  const token = localStorage.getItem("token");
  const headers = Object.assign({}, options.headers || {}, token ? { Authorization: "Bearer " + token } : {});
  return fetch(`${apiBase}${url.startsWith("/") ? "" : "/"}${url}`, Object.assign({}, options, { headers }));
};
(async function checkAuth() {
    //  specify allowed roles per page
  const pageRequiredRoles = window.requiredRoles || []; // e.g. ["manager"]
  const token = localStorage.getItem("token");
  

  // Show session expired alert if redirected due to session expiry
  if (localStorage.getItem("sessionExpired")) {
    alert("Your session has expired. Please sign in again.");
    localStorage.removeItem("sessionExpired");
  }

  if (token) {
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      if (payload.exp && payload.exp * 1000 < Date.now()) {
        console.warn("Token expired, redirecting to login.");
        localStorage.clear();
        localStorage.setItem("sessionExpired", "true");
        window.location.href = "/start.html";
        return;
      }
    } catch (e) {
      console.error("Invalid token format, clearing session.");
      localStorage.clear();
      window.location.href = "/start.html";
      return;
    }
  }

  if (!token) {
    window.location.href = "/start.html";
    return;
  }

  try {
    const res = await fetch(`${apiBase}/users/me`, {
      headers: { Authorization: "Bearer " + token },
    });

    if (!res.ok) throw new Error("Auth failed");

    const user = await res.json();
    const welcome = document.getElementById("welcome");
    if (welcome) {
      const displayName = user.first_name
        ? `${user.first_name}${user.last_name ? " " + user.last_name : ""}`
        : user.name || "User";
      welcome.textContent = "Welcome, " + displayName;
    }

    window.currentUser = user; // make available globally if needed
        // Role-based access control
    if (pageRequiredRoles.length > 0 && !pageRequiredRoles.includes(user.role)) {
      alert("Access denied. You do not have permission to view this page.");
      window.location.href = "/start.html";
      return;
    }


  } catch (err) {
    localStorage.clear();
    window.location.href = "/start.html";
  }
})();