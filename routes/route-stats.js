const express = require("express");
const { ensureAuthenticated } = require("../middleware/auth");

module.exports = function (pool) {
  const router = express.Router();

  // GET /stats/organizations - List all organizations with total savings
  router.get("/stats/organizations", ensureAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;

      // Get organizations the user created events for, with savings calculated from line items
      const query = `
        WITH user_orgs AS (
          SELECT DISTINCT o.id, o.name, o.currency
          FROM organisations o
          INNER JOIN events e ON e.organisation_id = o.id
          WHERE e.created_by = $1
        ),
        line_item_savings AS (
          SELECT 
            e.organisation_id,
            li.id as line_item_id,
            li.ext_baseline,
            COALESCE(MIN(b.amount), li.ext_baseline) as winning_bid,
            CASE 
              WHEN MIN(b.amount) IS NOT NULL AND li.ext_baseline IS NOT NULL
              THEN li.ext_baseline - MIN(b.amount)
              ELSE 0
            END as savings
          FROM events e
          INNER JOIN lots l ON l.event_id = e.id
          INNER JOIN line_items li ON li.lot_id = l.id
          LEFT JOIN bids b ON b.line_item_id = li.id AND b.event_id = e.id
          WHERE e.created_by = $1 
            AND e.auction_time < NOW()
            AND li.ext_baseline IS NOT NULL
          GROUP BY e.organisation_id, li.id, li.ext_baseline
        )
        SELECT 
          uo.id,
          uo.name,
          uo.currency,
          COUNT(DISTINCT lis.line_item_id) as line_item_count,
          COALESCE(SUM(lis.savings), 0) as total_savings
        FROM user_orgs uo
        LEFT JOIN line_item_savings lis ON lis.organisation_id = uo.id
        GROUP BY uo.id, uo.name, uo.currency
        ORDER BY uo.name;
      `;

      const result = await pool.query(query, [userId]);
      
      // Also get event counts per org
      const eventCountQuery = `
        SELECT 
          e.organisation_id,
          COUNT(DISTINCT e.id) as event_count
        FROM events e
        WHERE e.created_by = $1 AND e.auction_time < NOW()
        GROUP BY e.organisation_id
      `;
      const eventCounts = await pool.query(eventCountQuery, [userId]);
      
      // Merge event counts with results
      const merged = result.rows.map(org => {
        const eventCount = eventCounts.rows.find(ec => ec.organisation_id === org.id);
        return {
          ...org,
          event_count: eventCount ? parseInt(eventCount.event_count) : 0
        };
      });

      res.json(merged);
    } catch (err) {
      console.error("Error fetching organization stats:", err);
      res.status(500).json({ error: "Failed to fetch organization statistics" });
    }
  });

  // GET /stats/organizations/:orgId/categories - Get savings by category for an org
  router.get("/stats/organizations/:orgId/categories", ensureAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      const { orgId } = req.params;

      // Verify user has access to this organization (created events for it)
      const accessCheck = await pool.query(
        `SELECT 1 FROM events e
         WHERE e.organisation_id = $1 AND e.created_by = $2
         LIMIT 1`,
        [orgId, userId]
      );

      if (accessCheck.rows.length === 0) {
        return res.status(403).json({ error: "Access denied" });
      }

      const query = `
        WITH line_item_savings AS (
          SELECT 
            e.category_id,
            li.id as line_item_id,
            li.ext_baseline,
            COALESCE(MIN(b.amount), li.ext_baseline) as winning_bid,
            CASE 
              WHEN MIN(b.amount) IS NOT NULL AND li.ext_baseline IS NOT NULL
              THEN li.ext_baseline - MIN(b.amount)
              ELSE 0
            END as savings
          FROM events e
          INNER JOIN lots l ON l.event_id = e.id
          INNER JOIN line_items li ON li.lot_id = l.id
          LEFT JOIN bids b ON b.line_item_id = li.id AND b.event_id = e.id
          WHERE e.organisation_id = $1 
            AND e.created_by = $2 
            AND e.auction_time < NOW()
            AND li.ext_baseline IS NOT NULL
          GROUP BY e.category_id, li.id, li.ext_baseline
        ),
        event_counts AS (
          SELECT 
            e.category_id,
            COUNT(DISTINCT e.id) as event_count
          FROM events e
          WHERE e.organisation_id = $1 
            AND e.created_by = $2 
            AND e.auction_time < NOW()
          GROUP BY e.category_id
        )
        SELECT 
          c.id as category_id,
          c.name as category_name,
          COALESCE(ec.event_count, 0) as event_count,
          COALESCE(SUM(lis.savings), 0) as total_savings
        FROM categories c
        LEFT JOIN line_item_savings lis ON lis.category_id = c.id
        LEFT JOIN event_counts ec ON ec.category_id = c.id
        WHERE c.id IN (
          SELECT DISTINCT e.category_id 
          FROM events e 
          WHERE e.organisation_id = $1 
            AND e.created_by = $2 
            AND e.auction_time < NOW()
            AND e.category_id IS NOT NULL
        )
        GROUP BY c.id, c.name, ec.event_count
        ORDER BY total_savings DESC;
      `;

      const result = await pool.query(query, [orgId, userId]);
      res.json(result.rows);
    } catch (err) {
      console.error("Error fetching category stats:", err);
      res.status(500).json({ error: "Failed to fetch category statistics" });
    }
  });

  // GET /stats/organizations/:orgId/categories/:categoryId/events - Get past events for org+category
  router.get("/stats/organizations/:orgId/categories/:categoryId/events", ensureAuthenticated, async (req, res) => {
    try {
      const userId = req.user.id;
      const { orgId, categoryId } = req.params;

      // Verify user has access to this organization (created events for it)
      const accessCheck = await pool.query(
        `SELECT 1 FROM events e
         WHERE e.organisation_id = $1 AND e.created_by = $2
         LIMIT 1`,
        [orgId, userId]
      );

      if (accessCheck.rows.length === 0) {
        return res.status(403).json({ error: "Access denied" });
      }

      const query = `
        WITH event_savings AS (
          SELECT 
            e.id,
            e.auction_time,
            SUM(li.ext_baseline) as total_baseline,
            SUM(
              CASE 
                WHEN MIN(b.amount) IS NOT NULL 
                THEN MIN(b.amount)
                ELSE li.ext_baseline
              END
            ) as total_winning_bids,
            SUM(
              CASE 
                WHEN MIN(b.amount) IS NOT NULL AND li.ext_baseline IS NOT NULL
                THEN li.ext_baseline - MIN(b.amount)
                ELSE 0
              END
            ) as savings
          FROM events e
          INNER JOIN lots l ON l.event_id = e.id
          INNER JOIN line_items li ON li.lot_id = l.id
          LEFT JOIN bids b ON b.line_item_id = li.id AND b.event_id = e.id
          WHERE e.organisation_id = $1 
            AND e.category_id = $2 
            AND e.auction_time < NOW()
            AND e.created_by = $3
            AND li.ext_baseline IS NOT NULL
          GROUP BY e.id, e.auction_time, li.id, li.ext_baseline
        )
        SELECT 
          id,
          auction_time,
          SUM(total_baseline) as starting_price,
          SUM(total_winning_bids) as winning_bid,
          SUM(savings) as savings
        FROM event_savings
        GROUP BY id, auction_time
        ORDER BY auction_time DESC;
      `;

      const result = await pool.query(query, [orgId, categoryId, userId]);
      res.json(result.rows);
    } catch (err) {
      console.error("Error fetching event stats:", err);
      res.status(500).json({ error: "Failed to fetch event statistics" });
    }
  });

  return router;
};

