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
        console.log('✓ Registered plugins:', Chart.registry.plugins.keys());
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
let xScaleInterval = null;
let currentBaselineValue = null;

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
          ticks: { callback: v => `${v}m` },
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
          callbacks: {
            label: ctx => {
              const d = ctx.raw;
              if (!d) return '';
              const name = ctx.dataset.label || 'Bidder';
              const y = d.y.toFixed(2);
              return `${name}: ${y}`;
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
              xMax: 10,
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

function getRandomColor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = hash % 360;
  return `hsl(${h}, 70%, 60%)`;
}

// --- Graph Types ---

// Helper: Aggregate total extended bid over time for a bidder
function aggregateTotalPriceSeries(bids) {
  // bids: array of { time, extendedBid, line_item_id }
  if (!Array.isArray(bids) || bids.length === 0) return [];
  const sorted = bids.slice().sort((a, b) => a.time - b.time);
  const currentByLine = new Map();
  const series = [];
  for (const b of sorted) {
    if (!b) continue;
    const t = typeof b.time === 'number' ? b.time : 0;
    if (b.line_item_id != null) currentByLine.set(b.line_item_id, Number(b.extendedBid) || 0);
    let total = 0;
    currentByLine.forEach(v => { if (Number.isFinite(v)) total += v; });
    if (series.length && series[series.length - 1].x === t) {
      series[series.length - 1].y = total;
    } else {
      series.push({ x: t, y: total });
    }
  }
  return series;
}

// 1️⃣ Savings by Bidder (default)
function showSavingsByBidder(biddersMap, currencySymbol = '£', baselineValue = null, reserveValue = null) {
  if (!chart) initChart('bid-chart');
  // Each Y value is the actual event total extended price for the bidder (not shifted)
  const datasets = Array.from(biddersMap.values()).map(bidder => {
    const pointsRaw = aggregateTotalPriceSeries(bidder.bids || []);
    const points = pointsRaw; // keep actual totals, no shift
    return {
      label: bidder.user_name,
      data: points,
      borderColor: getRandomColor(bidder.user_name),
      fill: false,
      tension: 0.3,
      borderWidth: 2,
      pointRadius: 3
    };
  });

  updateChart(datasets);

  // Update baseline annotation if it exists
  if (chart.options.plugins?.annotation?.annotations) {
    if (baselineValue !== null) {
      currentBaselineValue = baselineValue;
      
      // Create or update baseline annotation
      chart.options.plugins.annotation.annotations.baselineLine = {
        type: 'line',
        yMin: baselineValue,
        yMax: baselineValue,
        xMin: 0,
        xMax: chart.options.scales.x.max || 10,
        borderColor: 'rgba(34, 197, 94, 0.5)',
        borderWidth: 3,
        borderDash: []
      };
      console.log('Updated baseline annotation to y =', baselineValue);
    } else if (chart.options.plugins.annotation.annotations.baselineLine) {
      delete chart.options.plugins.annotation.annotations.baselineLine;
    }
  }

  // ticks show actual prices
  chart.options.scales.y.ticks.callback = v =>
    `${currencySymbol}${v.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  // Tooltip label shows actual price
  chart.options.plugins.tooltip.callbacks.label = ctx => {
    const d = ctx.raw;
    if (!d) return '';
    const name = ctx.dataset.label || 'Bidder';
    const yActual = d.y;
    return `${name}: ${currencySymbol}${yActual.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  };

  // Update the chart to apply all changes
  chart.update('none');
}

// 2️⃣ Specific Line Item Chart
function showLineItemChart(lineItemId, allBids, baselineMap, auctionStart, currencySymbol = '£', baselineValue = null, reserveValue = null) {
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
    borderColor: getRandomColor(name),
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
  if (xScaleInterval) {
    clearInterval(xScaleInterval);
    xScaleInterval = null;
  }
  currentBaselineValue = null;
}

// Start x-axis expansion (call when auction goes live)
function startXAxisExpansion() {
  if (xScaleInterval) return; // Already running
  
  xScaleInterval = setInterval(() => {
    if (chart && chart.options && chart.options.scales && chart.options.scales.x) {
      if (typeof chart.options.scales.x.max === 'number') {
        chart.options.scales.x.max += 0.5;
        chart.update('none');
      }
    }
  }, 30000); // Every 30 seconds, add 0.5 minutes
  
  console.log('X-axis expansion started');
}

// Stop x-axis expansion (call when auction ends or pauses)
function stopXAxisExpansion() {
  if (xScaleInterval) {
    clearInterval(xScaleInterval);
    xScaleInterval = null;
    console.log('X-axis expansion stopped');
  }
}

// Default export (for non-module scripts)
window.AuctionGraphs = {
  initChart,
  showSavingsByBidder,
  showLineItemChart,
  clearChart,
  startXAxisExpansion,
  stopXAxisExpansion
};