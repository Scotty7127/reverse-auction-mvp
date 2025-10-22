// auction-graphs.js
// Handles all Chart.js graph rendering for auction.html
// Requires Chart.js Annotation plugin (to be included separately via CDN in HTML)

let chart = null;
let ctx = null;
let xScaleInterval = null;
let currentBaselineValue = null;

function initChart(canvasId, baselineValue = null, currencySymbol = '£') {
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
          max: 10
        },
        y: {
          beginAtZero: false,
          suggestedMin: baselineValue ? baselineValue * 0.9 : null,
          suggestedMax: baselineValue ? baselineValue * 1.1 : null,
          title: { display: true, text: 'Total Auction Price' },
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
          annotations: {
            baseline: {
              type: 'line',
              yMin: 0,
              yMax: 0,
              borderColor: 'green',
              borderWidth: 2,
              label: {
                enabled: true,
                content: 'Baseline (0)',
                position: 'start',
                backgroundColor: 'green',
                color: 'white',
                font: { weight: 'bold' }
              },
              drawTime: 'afterDatasetsDraw',
              scaleID: 'y'
            },
            reserve: {
              type: 'line',
              yMin: 0,
              yMax: 0,
              borderColor: 'red',
              borderWidth: 2,
              label: {
                enabled: true,
                content: 'Reserve',
                position: 'start',
                backgroundColor: 'red',
                color: 'white',
                font: { weight: 'bold' }
              },
              drawTime: 'afterDatasetsDraw',
              scaleID: 'y',
              display: false
            }
          }
        }
      }
    }
  });

  if (baselineValue !== null && baselineValue !== currentBaselineValue) {
    currentBaselineValue = baselineValue;
    chart.options.plugins.annotation.annotations.baseline.yMin = baselineValue;
    chart.options.plugins.annotation.annotations.baseline.yMax = baselineValue;
    chart.options.plugins.annotation.annotations.baseline.label.content =
      `Baseline (${currencySymbol}${baselineValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})})`;
    chart.update('none');
  }

  // Start interval to expand x-axis max by 1.5 every 1.5 minutes (90000 ms)
  if (!xScaleInterval) {
    xScaleInterval = setInterval(() => {
      if (chart && chart.options && chart.options.scales && chart.options.scales.x) {
        if (typeof chart.options.scales.x.max === 'number') {
          chart.options.scales.x.max += 1.5;
          chart.update('none');
        }
      }
    }, 90000);
  }
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

  if (baselineValue !== null && baselineValue !== currentBaselineValue) {
    currentBaselineValue = baselineValue;
    // baseline annotation line at y = baselineValue
    chart.options.plugins.annotation.annotations.baseline.yMin = baselineValue;
    chart.options.plugins.annotation.annotations.baseline.yMax = baselineValue;
    chart.options.plugins.annotation.annotations.baseline.label.content =
      `Baseline (${currencySymbol}${baselineValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})})`;
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

  if (chart.options.plugins.annotation?.annotations) {
    // reserve annotation logic unchanged
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

// Default export (for non-module scripts)
window.AuctionGraphs = {
  initChart,
  showSavingsByBidder,
  showLineItemChart,
  clearChart
};