// sockets/socket-auction-timer.js
const pool = require("../db/pool");

// Track active timers by event_id
const activeTimers = new Map();

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
          `SELECT auction_end_time, type, paused_time_remaining FROM events WHERE id = $1`,
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

        if (!endTime) {
          // No end time set, broadcast null
          io.to(`event_${eventId}`).emit("time_sync", {
            secondsRemaining: null,
            isPaused: isPaused,
            endTime: null
          });
          return;
        }

        let secondsRemaining;
        
        // If paused, use the frozen time from when it was paused
        if (isPaused && event.paused_time_remaining !== null) {
          secondsRemaining = event.paused_time_remaining;
        } else {
          // Not paused, calculate actual time remaining
          const now = new Date();
          const end = new Date(endTime);
          const msRemaining = end - now;
          secondsRemaining = Math.max(0, Math.floor(msRemaining / 1000));
        }

        // Broadcast to all clients in this event room
        io.to(`event_${eventId}`).emit("time_sync", {
          secondsRemaining: secondsRemaining,
          isPaused: isPaused,
          endTime: endTime ? new Date(endTime).toISOString() : null
        });

        // If auction is over (and not paused), stop the timer
        if (secondsRemaining === 0 && !isPaused) {
          console.log(`⏰ Auction ${eventId} time expired`);
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
