// middleware/team-access.js
const pool = require("../db/pool");

/**
 * Check if a user is a team member of an event
 * @param {number} eventId - The event ID
 * @param {number} userId - The user ID
 * @returns {Promise<boolean>} - True if user is a team member
 */
async function checkTeamMembership(eventId, userId) {
  const result = await pool.query(
    `SELECT * FROM event_members 
     WHERE event_id = $1 AND user_id = $2 AND role IN ('creator', 'participant')`,
    [eventId, userId]
  );
  return result.rows.length > 0;
}

/**
 * Middleware to ensure the authenticated manager is a team member of the event
 * Event ID should be in req.params.id or req.params.eventId
 */
async function ensureTeamMember(req, res, next) {
  try {
    if (req.user.role !== "manager") {
      return res.status(403).json({ error: "Access denied" });
    }

    const eventId = req.params.id || req.params.eventId;
    if (!eventId) {
      return res.status(400).json({ error: "Event ID not provided" });
    }

    const isMember = await checkTeamMembership(eventId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: "You are not a team member of this event" });
    }

    next();
  } catch (err) {
    console.error("Error checking team membership:", err);
    res.status(500).json({ error: "Failed to verify team membership" });
  }
}

/**
 * Get event ID from a lot ID
 * @param {number} lotId - The lot ID
 * @returns {Promise<number|null>} - The event ID or null
 */
async function getEventIdFromLot(lotId) {
  const result = await pool.query(
    "SELECT event_id FROM lots WHERE id = $1",
    [lotId]
  );
  return result.rows[0]?.event_id || null;
}

/**
 * Get event ID from a line item ID
 * @param {number} lineItemId - The line item ID
 * @returns {Promise<number|null>} - The event ID or null
 */
async function getEventIdFromLineItem(lineItemId) {
  const result = await pool.query(
    `SELECT l.event_id FROM line_items li
     JOIN lots l ON li.lot_id = l.id
     WHERE li.id = $1`,
    [lineItemId]
  );
  return result.rows[0]?.event_id || null;
}

/**
 * Middleware to ensure the authenticated manager is a team member of the event
 * Event ID is derived from lot ID in req.params.id
 */
async function ensureTeamMemberForLot(req, res, next) {
  try {
    if (req.user.role !== "manager") {
      return res.status(403).json({ error: "Access denied" });
    }

    const lotId = req.params.id;
    if (!lotId) {
      return res.status(400).json({ error: "Lot ID not provided" });
    }

    const eventId = await getEventIdFromLot(lotId);
    if (!eventId) {
      return res.status(404).json({ error: "Lot not found" });
    }

    const isMember = await checkTeamMembership(eventId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: "You are not a team member of this event" });
    }

    req.eventId = eventId;
    next();
  } catch (err) {
    console.error("Error checking team membership:", err);
    res.status(500).json({ error: "Failed to verify team membership" });
  }
}

/**
 * Middleware to ensure the authenticated manager is a team member of the event
 * Event ID is derived from line item ID in req.params.id
 */
async function ensureTeamMemberForLineItem(req, res, next) {
  try {
    if (req.user.role !== "manager") {
      return res.status(403).json({ error: "Access denied" });
    }

    const lineItemId = req.params.id;
    if (!lineItemId) {
      return res.status(400).json({ error: "Line item ID not provided" });
    }

    const eventId = await getEventIdFromLineItem(lineItemId);
    if (!eventId) {
      return res.status(404).json({ error: "Line item not found" });
    }

    const isMember = await checkTeamMembership(eventId, req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: "You are not a team member of this event" });
    }

    req.eventId = eventId;
    next();
  } catch (err) {
    console.error("Error checking team membership:", err);
    res.status(500).json({ error: "Failed to verify team membership" });
  }
}

module.exports = {
  checkTeamMembership,
  ensureTeamMember,
  ensureTeamMemberForLot,
  ensureTeamMemberForLineItem,
  getEventIdFromLot,
  getEventIdFromLineItem,
};
