/**
 * Static, self-contained HTML shell for the RelayCore savings dashboard.
 *
 * The page ships zero dependencies: inline CSS + a small vanilla-JS runtime
 * that polls `/dashboard/stats.json` every few seconds and re-renders. It
 * mirrors the pxpipe reference dashboard aesthetic — monospace, card-based,
 * light/dark toggle persisted in localStorage, inline SVG sparklines (no
 * charting library). The markup below is intentionally a single string so the
 * route handler can serve it directly with no filesystem access.
 */

/** How often (ms) the client re-polls the stats endpoint. */
const POLL_INTERVAL_MS = 5_000;

/** Endpoint the client polls for the live {@link StatsSnapshot} JSON. */
const STATS_ENDPOINT = '/dashboard/stats.json';

const STYLES = `
:root {
  --bg: #0e0f13;
  --panel: #16181f;
  --panel-2: #1c1f28;
  --border: #262a35;
  --text: #e6e8ee;
  --muted: #8b91a1;
  --accent: #ff7a2f;
  --accent-2: #ffb072;
  --good: #4ade80;
  --bad: #f87171;
  --grid: #222634;
  --font: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace;
}
:root[data-theme="light"] {
  --bg: #f6f7f9;
  --panel: #ffffff;
  --panel-2: #f0f2f6;
  --border: #dfe3ea;
  --text: #1a1d24;
  --muted: #626875;
  --accent: #e5601a;
  --accent-2: #b7480f;
  --good: #16a34a;
  --bad: #dc2626;
  --grid: #e7eaf0;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); }
.wrap { max-width: 1180px; margin: 0 auto; padding: 24px 20px 64px; }
header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
h1 { font-size: 18px; margin: 0; letter-spacing: 0.02em; }
h1 .flame { color: var(--accent); }
.sub { color: var(--muted); font-size: 12px; }
.controls { display: flex; align-items: center; gap: 10px; }
.pill {
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--muted);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.dot.live { background: var(--good); box-shadow: 0 0 0 0 var(--good); animation: pulse 2s infinite; }
.dot.stale { background: var(--bad); }
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(74,222,128,0.5); }
  70% { box-shadow: 0 0 0 6px rgba(74,222,128,0); }
  100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); }
}
button.toggle {
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 8px;
  padding: 5px 12px;
  font-family: var(--font);
  font-size: 12px;
  cursor: pointer;
}
button.toggle:hover { border-color: var(--accent); }
.grid { display: grid; gap: 14px; }
.cols-4 { grid-template-columns: repeat(4, 1fr); }
.cols-2 { grid-template-columns: repeat(2, 1fr); }
@media (max-width: 880px) { .cols-4 { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 560px) { .cols-4, .cols-2 { grid-template-columns: 1fr; } }
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
}
.card h2 { font-size: 12px; color: var(--muted); margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
.kpi { display: flex; flex-direction: column; gap: 4px; }
.kpi .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
.kpi .value { font-size: 26px; font-weight: 700; letter-spacing: -0.01em; }
.kpi .value.accent { color: var(--accent); }
.kpi .value.good { color: var(--good); }
.kpi .foot { color: var(--muted); font-size: 11px; }
.hero { display: grid; grid-template-columns: 1.4fr 1fr; gap: 20px; align-items: center; }
@media (max-width: 720px) { .hero { grid-template-columns: 1fr; } }
.hero .big { font-size: 46px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; }
.hero .big .unit { font-size: 18px; color: var(--muted); font-weight: 600; margin-left: 6px; }
.split { display: flex; gap: 20px; flex-wrap: wrap; }
.split .seg { display: flex; flex-direction: column; gap: 2px; }
.split .seg .n { font-size: 18px; font-weight: 700; }
.split .seg .n.dedup { color: var(--accent); }
.split .seg .n.pxpipe { color: var(--accent-2); }
.split .seg .t { color: var(--muted); font-size: 11px; }
.bar { height: 8px; border-radius: 6px; background: var(--panel-2); overflow: hidden; display: flex; margin-top: 10px; }
.bar .fill-dedup { background: var(--accent); }
.bar .fill-pxpipe { background: var(--accent-2); }
.chart-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.tabs { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.tabs button {
  background: transparent; border: 0; color: var(--muted);
  font-family: var(--font); font-size: 11px; padding: 4px 12px; cursor: pointer;
}
.tabs button.active { background: var(--accent); color: #1a0d05; font-weight: 700; }
svg.chart { width: 100%; height: 160px; display: block; }
svg.chart .grid-line { stroke: var(--grid); stroke-width: 1; }
svg.chart .area { fill: var(--accent); opacity: 0.14; }
svg.chart .line { fill: none; stroke: var(--accent); stroke-width: 2; }
svg.chart .axis { fill: var(--muted); font-size: 9px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:last-child td { border-bottom: 0; }
.status-ok { color: var(--good); }
.status-bad { color: var(--bad); }
.empty { color: var(--muted); font-size: 12px; padding: 12px 4px; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 6px; font-size: 11px; background: var(--panel-2); border: 1px solid var(--border); }
.err-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); }
.err-row:last-child { border-bottom: 0; }
footer { margin-top: 28px; color: var(--muted); font-size: 11px; text-align: center; }
.mono-muted { color: var(--muted); font-variant-numeric: tabular-nums; }
`;

const SCRIPT = `
(function () {
  "use strict";
  var POLL = ${POLL_INTERVAL_MS};
  var ENDPOINT = ${JSON.stringify(STATS_ENDPOINT)};
  var STALE_AFTER = POLL * 3;
  var granularity = "hourly";
  var lastData = null;
  var lastOkAt = 0;

  var root = document.documentElement;
  var savedTheme = null;
  try { savedTheme = localStorage.getItem("rc-theme"); } catch (e) {}
  root.setAttribute("data-theme", savedTheme === "light" ? "light" : "dark");

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtInt(n) {
    if (n === null || n === undefined || isNaN(n)) return "0";
    return Math.round(n).toLocaleString("en-US");
  }

  function fmtCompact(n) {
    n = Number(n) || 0;
    var abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }

  function fmtPct(n) {
    n = Number(n) || 0;
    return n.toFixed(1) + "%";
  }

  function fmtMs(n) {
    n = Number(n) || 0;
    if (n >= 1000) return (n / 1000).toFixed(2) + "s";
    return Math.round(n) + "ms";
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    var u = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i === 0 ? 0 : 1) + " " + u[i];
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour12: false }) +
      " " + d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function renderChart(series) {
    var W = 720, H = 160, padL = 4, padR = 4, padT = 10, padB = 18;
    var innerW = W - padL - padR, innerH = H - padT - padB;
    if (!series || series.length === 0) {
      return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"></svg>';
    }
    var max = 0;
    for (var i = 0; i < series.length; i++) max = Math.max(max, series[i].tokensSaved);
    if (max <= 0) max = 1;
    var n = series.length;
    var stepX = n > 1 ? innerW / (n - 1) : 0;
    function x(i) { return padL + stepX * i; }
    function y(v) { return padT + innerH - (v / max) * innerH; }

    var gridLines = "";
    for (var g = 0; g <= 2; g++) {
      var gy = padT + (innerH / 2) * g;
      gridLines += '<line class="grid-line" x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" />';
    }

    var linePts = "", areaPts = "";
    for (var j = 0; j < n; j++) {
      var px = x(j).toFixed(1), py = y(series[j].tokensSaved).toFixed(1);
      linePts += (j === 0 ? "M" : "L") + px + " " + py + " ";
      areaPts += (j === 0 ? "M" : "L") + px + " " + py + " ";
    }
    areaPts += "L" + x(n - 1).toFixed(1) + " " + (padT + innerH) + " L" + x(0).toFixed(1) + " " + (padT + innerH) + " Z";

    var first = series[0], last = series[n - 1];
    var firstLabel = granularity === "hourly"
      ? new Date(first.start).toLocaleTimeString("en-US", { hour: "2-digit", hour12: false }) + "h"
      : new Date(first.start).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    var lastLabel = granularity === "hourly"
      ? new Date(last.start).toLocaleTimeString("en-US", { hour: "2-digit", hour12: false }) + "h"
      : new Date(last.start).toLocaleDateString("en-US", { month: "short", day: "numeric" });

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      gridLines +
      '<path class="area" d="' + areaPts + '" />' +
      '<path class="line" d="' + linePts + '" />' +
      '<text class="axis" x="' + padL + '" y="' + (H - 5) + '">' + esc(firstLabel) + '</text>' +
      '<text class="axis" x="' + (W - padR) + '" y="' + (H - 5) + '" text-anchor="end">' + esc(lastLabel) + '</text>' +
      '<text class="axis" x="' + padL + '" y="' + (padT + 8) + '">peak ' + esc(fmtCompact(max)) + '</text>' +
      '</svg>';
  }

  function render() {
    if (!lastData) return;
    var d = lastData, t = d.totals, tr = d.traffic;

    $("kpi-saved").textContent = fmtCompact(t.tokensSaved);
    $("kpi-savings").textContent = fmtPct(t.savingsPct);
    $("kpi-requests").textContent = fmtInt(t.requests);
    $("kpi-estin").textContent = fmtCompact(t.estInputTokens) + " est. input tokens";

    $("kpi-avg").textContent = fmtMs(tr.avgDurationMs);
    $("kpi-p95").textContent = fmtMs(tr.p95DurationMs);
    $("kpi-bytes").textContent = fmtBytes(t.bytesIn) + " → " + fmtBytes(t.bytesOut);
    $("kpi-images").textContent = fmtInt(t.imageTransforms) + " converted to images";

    // Breakdown
    var dedup = t.dedupTokensSaved || 0, px = t.pxpipeTokensSaved || 0;
    var sum = dedup + px;
    $("seg-dedup").textContent = fmtCompact(dedup);
    $("seg-pxpipe").textContent = fmtCompact(px);
    var dPct = sum > 0 ? (dedup / sum) * 100 : 50;
    $("fill-dedup").style.width = dPct + "%";
    $("fill-pxpipe").style.width = (100 - dPct) + "%";
    $("seg-dedup-sub").textContent = fmtInt(t.blocksDeduped) + " blocks deduped";
    $("seg-pxpipe-sub").textContent = fmtInt(t.blocksConverted) + " blocks · " + fmtInt(t.pagesRendered) + " pages · " + fmtInt(t.cacheHits) + " cache hits";

    // Chart
    var series = granularity === "hourly" ? d.hourly : d.daily;
    $("chart").innerHTML = renderChart(series);

    // Errors
    var errs = tr.errorsByStatus || [];
    if (errs.length === 0) {
      $("errors").innerHTML = '<div class="empty">No errors recorded.</div>';
    } else {
      $("errors").innerHTML = errs.map(function (e) {
        return '<div class="err-row"><span class="status-bad">HTTP ' + esc(e.statusCode) +
          '</span><span class="mono-muted">' + fmtInt(e.count) + '</span></div>';
      }).join("");
    }
    $("misc").innerHTML =
      '<div class="err-row"><span>Render failures</span><span class="mono-muted">' + fmtInt(t.renderFailures) + '</span></div>' +
      '<div class="err-row"><span>Upstream rejections</span><span class="mono-muted">' + fmtInt(t.upstreamRejections) + '</span></div>' +
      '<div class="err-row"><span>Cache hits</span><span class="mono-muted">' + fmtInt(t.cacheHits) + '</span></div>';

    // Recent
    var recent = d.recent || [];
    if (recent.length === 0) {
      $("recent-body").innerHTML = '<tr><td colspan="6" class="empty">No requests yet.</td></tr>';
    } else {
      $("recent-body").innerHTML = recent.map(function (r) {
        var ok = r.statusCode < 400;
        return '<tr>' +
          '<td class="mono-muted">' + esc(fmtTime(r.ts)) + '</td>' +
          '<td><span class="badge">' + esc(r.route) + '</span></td>' +
          '<td>' + esc(r.model || "—") + '</td>' +
          '<td class="num ' + (ok ? "status-ok" : "status-bad") + '">' + esc(r.statusCode) + '</td>' +
          '<td class="num mono-muted">' + esc(fmtMs(r.durationMs)) + '</td>' +
          '<td class="num" style="color:var(--accent)">' + fmtCompact(r.tokensSaved) + '</td>' +
          '</tr>';
      }).join("");
    }

    var from = d.windowFrom ? fmtTime(d.windowFrom) : "—";
    $("window").textContent = "since " + from;
    $("generated").textContent = "updated " + new Date(d.generatedAt).toLocaleTimeString("en-US", { hour12: false });

    // Top sessions
    var top = d.topSessions || [];
    if (top.length === 0) {
      $("top-sessions-body").innerHTML = '<tr><td colspan="7" class="empty">No sessions yet.</td></tr>';
    } else {
      $("top-sessions-body").innerHTML = top.map(function (s) {
        return '<tr>' +
          '<td class="mono-muted" style="font-size:11px">' + esc(s.sessionId) + '</td>' +
          '<td class="num">' + fmtInt(s.requests) + '</td>' +
          '<td class="num" style="color:var(--accent)">' + fmtCompact(s.tokensSaved) + '</td>' +
          '<td class="num">' + fmtCompact(s.dedupTokensSaved) + '</td>' +
          '<td class="num">' + fmtCompact(s.pxpipeTokensSaved) + '</td>' +
          '<td class="num">' + fmtInt(s.imageTransforms) + '</td>' +
          '<td class="num mono-muted">' + fmtBytes(s.bytesIn) + '</td>' +
          '</tr>';
      }).join("");
    }

    // Full history
    var all = d.allSessions || [];
    if (all.length === 0) {
      $("all-sessions-body").innerHTML = '<tr><td colspan="7" class="empty">No sessions yet.</td></tr>';
    } else {
      $("all-sessions-body").innerHTML = all.map(function (s) {
        return '<tr>' +
          '<td class="mono-muted" style="font-size:11px">' + esc(s.sessionId) + '</td>' +
          '<td class="num">' + fmtInt(s.requests) + '</td>' +
          '<td class="num" style="color:var(--accent)">' + fmtCompact(s.tokensSaved) + '</td>' +
          '<td class="num">' + fmtCompact(s.dedupTokensSaved) + '</td>' +
          '<td class="num">' + fmtCompact(s.pxpipeTokensSaved) + '</td>' +
          '<td class="num">' + fmtInt(s.imageTransforms) + '</td>' +
          '<td class="num mono-muted">' + fmtBytes(s.bytesIn) + '</td>' +
          '</tr>';
      }).join("");
    }
  }

  function setStatus(live) {
    var dot = $("live-dot"), txt = $("live-text");
    if (live) { dot.className = "dot live"; txt.textContent = "live"; }
    else { dot.className = "dot stale"; txt.textContent = "stale"; }
  }

  function poll() {
    fetch(ENDPOINT, { headers: { accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (json) { lastData = json; lastOkAt = Date.now(); setStatus(true); render(); })
      .catch(function () { if (Date.now() - lastOkAt > STALE_AFTER) setStatus(false); });
  }

  document.addEventListener("click", function (ev) {
    var el = ev.target.closest("[data-gran]");
    if (el) {
      granularity = el.getAttribute("data-gran");
      var tabs = document.querySelectorAll("[data-gran]");
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("active", tabs[i] === el);
      render();
      return;
    }
    if (ev.target.closest("#theme-toggle")) {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("rc-theme", next); } catch (e) {}
    }
  });

  poll();
  setInterval(poll, POLL);
})();
`;

/**
 * Returns the complete static HTML document for the dashboard. The result is a
 * fully self-contained page (inline styles + script); no external requests are
 * made beyond the JSON polling endpoint.
 */
export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>RelayCore · Token Savings</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1><span class="flame">▲</span> RelayCore <span class="sub">token savings</span></h1>
      <div class="sub" id="window">since —</div>
    </div>
    <div class="controls">
      <span class="pill"><span class="dot" id="live-dot"></span><span id="live-text">connecting</span></span>
      <span class="pill" id="generated">updated —</span>
      <button class="toggle" id="theme-toggle" type="button">◐ theme</button>
    </div>
  </header>

  <div class="card" style="margin-bottom:14px;">
    <div class="hero">
      <div>
        <div class="kpi"><span class="label">Total tokens saved</span></div>
        <div class="big"><span id="kpi-saved">0</span><span class="unit">tokens</span></div>
        <div class="foot mono-muted" id="kpi-estin">0 est. input tokens</div>
      </div>
      <div>
        <div class="split">
          <div class="seg"><span class="n dedup" id="seg-dedup">0</span><span class="t">dedup</span><span class="t" id="seg-dedup-sub"></span></div>
          <div class="seg"><span class="n pxpipe" id="seg-pxpipe">0</span><span class="t">pxpipe</span><span class="t" id="seg-pxpipe-sub"></span></div>
        </div>
        <div class="bar">
          <div class="fill-dedup" id="fill-dedup" style="width:50%"></div>
          <div class="fill-pxpipe" id="fill-pxpipe" style="width:50%"></div>
        </div>
      </div>
    </div>
  </div>

  <div class="grid cols-4" style="margin-bottom:14px;">
    <div class="card kpi"><span class="label">Savings rate</span><span class="value good" id="kpi-savings">0%</span><span class="foot">tokens saved ÷ est. input</span></div>
    <div class="card kpi"><span class="label">Requests</span><span class="value" id="kpi-requests">0</span><span class="foot mono-muted" id="kpi-bytes">0 B → 0 B</span><span class="foot mono-muted" id="kpi-images">0 converted to images</span></div>
    <div class="card kpi"><span class="label">Avg latency</span><span class="value" id="kpi-avg">0ms</span><span class="foot">per request</span></div>
    <div class="card kpi"><span class="label">p95 latency</span><span class="value" id="kpi-p95">0ms</span><span class="foot">per request</span></div>
  </div>

  <div class="card" style="margin-bottom:14px;">
    <div class="chart-head">
      <h2 style="margin:0;">Tokens saved over time</h2>
      <div class="tabs">
        <button type="button" data-gran="hourly" class="active">24h</button>
        <button type="button" data-gran="daily">30d</button>
      </div>
    </div>
    <div id="chart"></div>
  </div>

  <div class="grid cols-2" style="margin-bottom:14px;">
    <div class="card">
      <h2>Errors by status</h2>
      <div id="errors"><div class="empty">No errors recorded.</div></div>
    </div>
    <div class="card">
      <h2>Pipeline health</h2>
      <div id="misc"></div>
    </div>
  </div>

  <div class="card">
    <h2>Recent requests</h2>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>Time</th><th>Route</th><th>Model</th>
            <th class="num">Status</th><th class="num">Latency</th><th class="num">Saved</th>
          </tr>
        </thead>
        <tbody id="recent-body">
          <tr><td colspan="6" class="empty">Loading…</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="card" style="margin-bottom:14px;">
    <h2>Top sessions (by tokens saved)</h2>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>Session</th><th class="num">Requests</th><th class="num">Saved</th>
            <th class="num">Dedup</th><th class="num">Pxpipe</th><th class="num">Images</th><th class="num">Input</th>
          </tr>
        </thead>
        <tbody id="top-sessions-body">
          <tr><td colspan="7" class="empty">Loading…</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="card" style="margin-bottom:14px;">
    <h2>Full history (all sessions)</h2>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>Session</th><th class="num">Requests</th><th class="num">Saved</th>
            <th class="num">Dedup</th><th class="num">Pxpipe</th><th class="num">Images</th><th class="num">Input</th>
          </tr>
        </thead>
        <tbody id="all-sessions-body">
          <tr><td colspan="7" class="empty">Loading…</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <footer>RelayCore dashboard · polling ${STATS_ENDPOINT} every ${POLL_INTERVAL_MS / 1000}s</footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>`;
}
