// sockets/socket-auction-timer.js
const pool = require("../db/pool");

// Track active timers by event_id
const activeTimers = new Map();
// Track if we've already logged the live notification for this event
const liveNotificationSent = new Map();

module.exports = (io) => {
  
  // Start broadcasting time for an event
  function startAuctionTimer(eventId) {
    // Don't start if already running
    if (activeTimers.has(eventId)) {
      return;
    }

    console.log(`⏱️  Starting auction timer broadcast for event ${eventId}`);

    const interval = setInterval(async () => {
      try {
        // Query the current auction state from DB
        const result = await pool.query(
          `SELECT auction_end_time, auction_time, type, paused_time_remaining, elapsed_seconds, title FROM events WHERE id = $1`,
          [eventId]
        );
        
        if (result.rows.length === 0) {
          console.log(`Event ${eventId} not found, stopping timer`);
          stopAuctionTimer(eventId);
          return;
        }

        const event = result.rows[0];
        const isPaused = event.type === 'paused';
        const endTime = event.auction_end_time;
        const startTime = event.auction_time;
        const eventTitle = event.title || `Event ${eventId}`;

        if (!endTime) {
          // No end time set, broadcast null
          io.to(`event_${eventId}`).emit("time_sync", {
            secondsRemaining: null,
            isPaused: isPaused,
            endTime: null,
            elapsedSeconds: null
          });
          return;
        }

        let secondsRemaining;
        let elapsedSeconds = event.elapsed_seconds || 0;
        
        // If paused, use the frozen values from database
        if (isPaused) {
          secondsRemaining = event.paused_time_remaining;
        } else {
          // Not paused - increment elapsed seconds by 1 and update DB
          elapsedSeconds = elapsedSeconds + 1;
          
          await pool.query(
            `UPDATE events SET elapsed_seconds = $1 WHERE id = $2`,
            [elapsedSeconds, eventId]
          );
          
          // Calculate actual time remaining
          const now = new Date();
          const end = new Date(endTime);
          const msRemaining = end - now;
          secondsRemaining = Math.max(0, Math.floor(msRemaining / 1000));
          
          // Check if auction just went live (has positive time remaining and hasn't been notified)
          if (secondsRemaining > 0 && !liveNotificationSent.get(eventId)) {
            console.log(`🚀 Auction is now LIVE: "${eventTitle}" (Event ID: ${eventId})`);
            liveNotificationSent.set(eventId, true);
          }
        }

        // Broadcast to all clients in this event room
        io.to(`event_${eventId}`).emit("time_sync", {
          secondsRemaining: secondsRemaining,
          isPaused: isPaused,
          endTime: endTime ? new Date(endTime).toISOString() : null,
          elapsedSeconds: elapsedSeconds
        });

        // If auction is over (and not paused), stop the timer
        if (secondsRemaining === 0 && !isPaused) {
          console.log(`🏁 Auction ended: "${eventTitle}" (Event ID: ${eventId})`);
          stopAuctionTimer(eventId);
        }

      } catch (err) {
        console.error(`Error in auction timer for event ${eventId}:`, err);
      }
    }, 1000); // Broadcast every second

    activeTimers.set(eventId, interval);
  }

  // Stop broadcasting time for an event
  function stopAuctionTimer(eventId) {
    const interval = activeTimers.get(eventId);
    if (interval) {
      clearInterval(interval);
      activeTimers.delete(eventId);
      liveNotificationSent.delete(eventId); // Clear notification flag so it can trigger again if restarted
      console.log(`⏱️  Stopped auction timer broadcast for event ${eventId}`);
    }
  }

  // When a user joins an event, start the timer if needed
  io.on("connection", (socket) => {
    socket.on("join_event", (eventId) => {
      socket.join(`event_${eventId}`);
      console.log(`User joined event room: event_${eventId}`);
      
      // Start timer for this event if not already running
      startAuctionTimer(eventId);
    });

    socket.on("leave_event", (eventId) => {
      socket.leave(`event_${eventId}`);
      console.log(`User left event room: event_${eventId}`);
      
      // Optionally: stop timer if no one is in the room anymore
      // (We'll keep it running for simplicity)
    });
  });

  // Expose functions for manual control
  return {
    startAuctionTimer,
    stopAuctionTimer,
    restartAuctionTimer: (eventId) => {
      stopAuctionTimer(eventId);
      startAuctionTimer(eventId);
    }
  };
};
