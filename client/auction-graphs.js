// auction-graphs.js
// Handles all Chart.js graph rendering for auction.html
// Requires Chart.js Annotation plugin (to be included separately via CDN in HTML)

// Wait for everything to load and register the annotation plugin
(function() {
  function tryRegisterPlugin() {
    const annotationPlugin = window['chartjs-plugin-annotation'];
    if (typeof Chart !== 'undefined' && annotationPlugin) {
      try {
        Chart.register(annotationPlugin.default || annotationPlugin);
        console.log('✓ Chart.js Annotation plugin registered successfully');
        console.log('✓ Chart.js version:', Chart.version);
        console.log('✓ Registered plugins:', Array.from(Chart.registry.plugins.keys()));
      } catch (e) {
        console.error('✗ Failed to register annotation plugin:', e);
      }
    } else {
      console.warn('⚠ Waiting for Chart.js or annotation plugin...', {
        Chart: typeof Chart !== 'undefined',
        annotationPlugin: !!annotationPlugin
      });
      setTimeout(tryRegisterPlugin, 100);
    }
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryRegisterPlugin);
  } else {
    tryRegisterPlugin();
  }
})();

let chart = null;
let ctx = null;
let auctionStartTime = null;
let currentBaselineValue = null;
let serverElapsedSeconds = 0; // Track server's elapsed time

function initChart(canvasId, baselineValue = null, currencySymbol = '£') {
  console.log('initChart called with baselineValue:', baselineValue);
  const el = document.getElementById(canvasId);
  if (!el) {
    console.error(`Canvas with id ${canvasId} not found.`);
    return;
  }
  // Destroy existing chart bound to this canvas if present
  if (chart && typeof chart.destroy === 'function') {
    try { chart.destroy(); } catch (e) { console.warn('Chart destroy failed (ignored):', e); }
    chart = null;
  }
  // Safety: if Chart.js has an internal instance tied to this element, destroy it
  if (typeof Chart !== 'undefined' && Chart.getChart) {
    const existing = Chart.getChart(el);
    if (existing) {
      try { existing.destroy(); } catch (e) { console.warn('Existing chart destroy failed (ignored):', e); }
    }
  }
  
  console.log('Creating chart with baseline annotation at y =', baselineValue);
  
  ctx = el.getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true,
      animation: false,
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Time (minutes)' },
          ticks: { 
            callback: v => `${v}m`,
            stepSize: 1  // Start with 1-minute intervals, will adjust dynamically
          },
          min: 0,
          max: 0.5
        },
        y: {
          beginAtZero: false,
          suggestedMin: baselineValue ? baselineValue * 0.9 : null,
          suggestedMax: baselineValue ? baselineValue * 1.1 : null,
          title: { display: true, text: 'Total Price' },
          ticks: {
            callback: v => currencySymbol ? `${currencySymbol}${v.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : v
          }
        }
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          displayColors: true,
          callbacks: {
            title: ctx => {
              // Show price as the title
              if (!ctx || ctx.length === 0) return '';
              const point = ctx[0];
              const d = point.raw;
              if (!d) return '';
              const price = d.y;
              return `${currencySymbol}${price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
            },
            label: ctx => {
              // Show "Org Name @ time" or "Org Name @ Opening"
              const d = ctx.raw;
              if (!d) return '';
              const name = ctx.dataset.label || 'Bidder';
              const time = d.x ? `${d.x.toFixed(1)}m` : '';
              
              // Check if this is an opening bid
              if (name.toLowerCase().includes('opening') || d.isOpening) {
                return `${name} @ Opening`;
              }
              
              return `${name} @ ${time}`;
            }
          }
        },
        annotation: {
          annotations: baselineValue ? {
            baselineLine: {
              type: 'line',
              yMin: baselineValue,
              yMax: baselineValue,
              xMin: 0,
              xMax: (context) => {
                // Dynamically extend to the current x-axis max
                return context.chart.scales.x.max;
              },
              borderColor: 'rgba(34, 197, 94, 0.5)',
              borderWidth: 3,
              borderDash: []
            }
          } : {},
          clip: false
        }
      }
    }
  });
  
  console.log('Chart created. Checking annotation config:', chart.options.plugins.annotation);

  if (baselineValue !== null) {
    currentBaselineValue = baselineValue;
    console.log('Baseline annotation should be at y =', baselineValue);
    chart.update('none');
  }

  // Don't start the x-axis expansion here - wait for startXAxisExpansion() to be called
}

function updateChart(datasets) {
  if (!chart) return;
  chart.data.datasets = datasets;
  chart.update('none');
}

function getRandomColor(seed, eventId = null) {
  // Add eventId to seed to make colors random per event
  const fullSeed = eventId ? `${seed}-${eventId}` : seed;
  
  let hash = 0;
  for (let i = 0; i < fullSeed.length; i++) {
    hash = fullSeed.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  // Get hue from hash, but exclude green range (90-150°) to avoid baseline color
  // Baseline is green: rgba(34, 197, 94, 0.5) ≈ hsl(142, 70%, 45%)
  let h = Math.abs(hash) % 360;
  
  // If in green range, shift to another color
  if (h >= 90 && h <= 150) {
    // Shift to red/orange range (0-60) or blue/purple range (200-280)
    h = (h < 120) ? (h - 90) : (h + 80);
  }
  
  return `hsl(${h}, 70%, 60%)`;
}

// --- Graph Types ---

// Helper: Aggregate total price over time for a bidder
// 1️⃣ Savings by Bidder (default)
function showSavingsByBidder(biddersMap, currencySymbol = '£', baselineValue = null, reserveValue = null, eventId = null) {
  if (!chart) initChart('bid-chart');
  
  // biddersMap should contain { user_name, points: [{x, y}] }
  // where points are the total prices at each submission time
  const datasets = Array.from(biddersMap.values()).map(bidder => {
    const points = bidder.points || [];
    
    return {
      label: bidder.user_name,
      data: points,
      borderColor: getRandomColor(bidder.user_name, eventId),
      fill: false,
      tension: 0.3,
      borderWidth: 2,
      pointRadius: 3
    };
  });

  updateChart(datasets);

  // Update baseline annotation
  if (chart.options.plugins?.annotation?.annotations) {
    if (baselineValue !== null) {
      currentBaselineValue = baselineValue;
      
      chart.options.plugins.annotation.annotations.baselineLine = {
        type: 'line',
        yMin: baselineValue,
        yMax: baselineValue,
        xMin: 0,
        xMax: (context) => {
          return context.chart.scales.x.max;
        },
        borderColor: 'rgba(34, 197, 94, 0.5)',
        borderWidth: 3,
        borderDash: []
      };
    }
  }

  // ticks show prices
  chart.options.scales.y.ticks.callback = v =>
    `${currencySymbol}${v.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  
  // Tooltip callbacks
  chart.options.plugins.tooltip.callbacks.title = ctx => {
    if (!ctx || ctx.length === 0) return '';
    const point = ctx[0];
    const d = point.raw;
    if (!d) return '';
    const price = d.y;
    return `Total: ${currencySymbol}${price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  };
  
  chart.options.plugins.tooltip.callbacks.label = ctx => {
    const d = ctx.raw;
    if (!d) return '';
    const name = ctx.dataset.label || 'Bidder';
    const time = d.x ? `${d.x.toFixed(1)}m` : '';
    
    if (name.toLowerCase().includes('opening') || d.isOpening) {
      return `${name} @ Opening`;
    }
    
    return `${name} @ ${time}`;
  };

  chart.update('none');
}

// 2️⃣ Specific Line Item Chart
function showLineItemChart(lineItemId, allBids, baselineMap, auctionStart, currencySymbol = '£', baselineValue = null, reserveValue = null, eventId = null) {
  if (!chart) initChart('bid-chart');
  const li = baselineMap.get(lineItemId);
  if (!li) {
    console.warn('No line item found for', lineItemId);
    return;
  }
  const filteredBids = allBids.filter(b => b.line_item_id === lineItemId);
  const bidders = {};
  filteredBids.forEach(b => {
    const name = b.user_name || `Bidder ${b.user_id}`;
    if (!bidders[name]) bidders[name] = [];
    const elapsed = auctionStart ? (new Date(b.created_at) - auctionStart) / 60000 : 0;
    bidders[name].push({ x: elapsed, y: b.amount });
  });
  const datasets = Object.entries(bidders).map(([name, points]) => ({
    label: name,
    data: points.sort((a,b)=>a.x-b.x),
    borderColor: getRandomColor(name, eventId),
    fill: false,
    tension: 0.3,
    borderWidth: 2,
    pointRadius: 3
  }));
  updateChart(datasets);

  if (chart.options.plugins.annotation?.annotations) {
    if (baselineValue !== null && baselineValue !== currentBaselineValue) {
      currentBaselineValue = baselineValue;
      chart.options.plugins.annotation.annotations.baseline.yMin = baselineValue;
      chart.options.plugins.annotation.annotations.baseline.yMax = baselineValue;
    }
    if (reserveValue !== null) {
      chart.options.plugins.annotation.annotations.reserve.yMin = reserveValue;
      chart.options.plugins.annotation.annotations.reserve.yMax = reserveValue;
      chart.options.plugins.annotation.annotations.reserve.display = true;
    } else {
      chart.options.plugins.annotation.annotations.reserve.display = false;
    }
    chart.update('none');
  }
}

// 3️⃣ Clear chart
function clearChart() {
  if (chart && typeof chart.destroy === 'function') {
    try { chart.destroy(); } catch (e) { console.warn('Chart destroy failed (ignored):', e); }
  }
  chart = null;
  ctx = null;
  auctionStartTime = null;
  currentBaselineValue = null;
}

// Start x-axis tracking (call when auction goes live)
// Pass the actual auction start time from the database
// Update x-axis based on server's elapsed time
function updateXAxisFromServer(elapsedSeconds) {
  if (!chart || !chart.options || !chart.options.scales || !chart.options.scales.x) return;
  
  serverElapsedSeconds = elapsedSeconds || 0;
  const elapsedMinutes = serverElapsedSeconds / 60;
  
  // Set x-axis max to show elapsed time (rounded up to next 0.5 minute for cleaner display)
  const displayMax = Math.max(0.5, Math.ceil(elapsedMinutes * 2) / 2);
  chart.options.scales.x.max = displayMax;
  
  // Dynamically adjust step size to keep ~8-12 ticks
  let stepSize;
  if (displayMax <= 5) {
    stepSize = 0.5;  // 0.5-minute intervals for short auctions
  } else if (displayMax <= 15) {
    stepSize = 1;    // 1-minute intervals for medium auctions
  } else if (displayMax <= 30) {
    stepSize = 2;    // 2-minute intervals
  } else if (displayMax <= 60) {
    stepSize = 5;    // 5-minute intervals
  } else {
    stepSize = 10;   // 10-minute intervals for very long auctions
  }
  chart.options.scales.x.ticks.stepSize = stepSize;
  
  chart.update('none');
}

// Reset x-axis tracking (call when auction ends or is reset)
function resetXAxisTracking() {
  stopXAxisExpansion();
  auctionStartTime = null;
  elapsedTimeAtPause = 0;
  if (chart && chart.options && chart.options.scales && chart.options.scales.x) {
    chart.options.scales.x.max = 0.5;
    chart.update('none');
  }
}

// Default export (for non-module scripts)
window.AuctionGraphs = {
  initChart,
  showSavingsByBidder,
  showLineItemChart,
  clearChart,
  updateXAxisFromServer,
  getColorForBidder: getRandomColor  // Export color function for use in rankings
};