import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  onValue,
  off,
  push,
  set,
  remove,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const cfg = window.FIREBASE_CONFIG || {};
if (!cfg.apiKey || cfg.apiKey === "YOUR_API_KEY") {
  alert("Edit admin-panel/firebase-config.js with your Firebase web config first.");
}

const app = initializeApp(cfg);
const auth = getAuth(app);
const db = getDatabase(app);

const $ = (id) => document.getElementById(id);
const loginWrap = $("login");
const appWrap = $("app");

let currentDeviceId = null;
let deviceList = {};
let liveOn = false;
const listeners = [];

let procCache = [];
let browserCache = [];
let shotsCache = [];
let historyCache = [];
let deviceFilter = "";
let procFilter = "";
let browserFilter = "";
let chartRange = 60;
const procSort = { key: "memMb", dir: -1 };
const browserSort = { key: "time", dir: -1 };

/* ---------- Auth ---------- */
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  $("login-error").textContent = "";
  btn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
  } catch (err) {
    $("login-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$("logout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user) {
    loginWrap.classList.add("hidden");
    appWrap.classList.remove("hidden");
    startDevices();
  } else {
    appWrap.classList.add("hidden");
    loginWrap.classList.remove("hidden");
    stopListeners();
    currentDeviceId = null;
  }
});

/* ---------- Devices ---------- */
function startDevices() {
  onValue(ref(db, "devices"), (snap) => {
    deviceList = snap.val() || {};
    renderDeviceList();
    renderDeviceGrid();
    if (currentDeviceId) {
      const id = currentDeviceId;
      stopListeners();
      currentDeviceId = null;
      selectDevice(id, true);
    }
  });
}

function renderDeviceList() {
  const ul = $("device-list");
  ul.innerHTML = "";
  const ids = sortedIds();
  if (!ids.length) {
    ul.innerHTML = '<li class="empty">No devices yet.<br><span class="sub">Run the python agent.</span></li>';
    return;
  }
  for (const id of ids) {
    const d = deviceList[id];
    const meta = d.meta || {};
    const online = isOnline(meta);
    const name = meta.name || d.info?.hostname || id.slice(0, 8);
    if (deviceFilter && !name.toLowerCase().includes(deviceFilter)) continue;
    const li = document.createElement("li");
    if (id === currentDeviceId) li.classList.add("active");
    li.innerHTML = `${avatarHtml(name, online)}
      <span class="info"><span class="nm">${escapeHtml(name)}</span>
      <span class="sub">${online ? "online" : "last seen " + fmtRelative(meta.lastSeen)}</span></span>`;
    li.onclick = () => selectDevice(id);
    ul.appendChild(li);
  }
}

function renderDeviceGrid() {
  const grid = $("device-grid");
  const ids = sortedIds();
  if (!ids.length) {
    grid.innerHTML = '<p class="empty">No devices connected yet. Start the python agent on a PC.</p>';
    return;
  }
  grid.innerHTML = ids
    .map((id) => {
      const d = deviceList[id];
      const meta = d.meta || {};
      const info = d.info || {};
      const stats = d.stats || {};
      const online = isOnline(meta);
      const cpu = Math.round(stats.cpuPercent || 0);
      const ram = Math.round(stats.ramPercent || 0);
      const name = meta.name || info.hostname || id.slice(0, 8);
      return `<div class="device-card" data-id="${escapeAttr(id)}">
        <div class="head">${avatarHtml(name, online)}<span class="nm">${escapeHtml(name)}</span></div>
        <div class="os">${escapeHtml(truncate(info.os || "", 46))}</div>
        <div class="metric"><span>CPU</span><span>${cpu}%</span></div>
        <div class="bar ${gaugeClass(cpu)}"><span style="width:${Math.min(cpu, 100)}%"></span></div>
        <div class="metric"><span>Memory</span><span>${ram}%</span></div>
        <div class="bar ${gaugeClass(ram)}"><span style="width:${Math.min(ram, 100)}%"></span></div>
        <div class="metric"><span>${online ? "online" : "last seen " + fmtRelative(meta.lastSeen)}</span>
        <span>${escapeHtml(info.localIp || "")}</span></div>
      </div>`;
    })
    .join("");
  grid.querySelectorAll(".device-card").forEach((c) => {
    c.onclick = () => selectDevice(c.dataset.id);
  });
}

function sortedIds() {
  return Object.keys(deviceList).sort(
    (a, b) => (deviceList[b].meta?.lastSeen || 0) - (deviceList[a].meta?.lastSeen || 0)
  );
}

function isOnline(meta) {
  if (!meta) return false;
  if (meta.online === false) return false;
  return meta.lastSeen ? Date.now() - meta.lastSeen < 60000 : false;
}

/* ---------- Device detail ---------- */
function stopListeners() {
  while (listeners.length) {
    const { r, cb } = listeners.pop();
    off(r, "value", cb);
  }
}

function selectDevice(id, keepTab) {
  if (rtcPc) rtcDisconnect();
  currentDeviceId = id;
  liveOn = false;
  renderDeviceList();
  closeMenu();
  stopListeners();
  if (!keepTab) activateTab("overview");

  const base = `devices/${id}`;
  bind(`${base}/info`, renderInfo);
  bind(`${base}/meta`, renderMeta);
  bind(`${base}/stats`, renderStats);
  bind(`${base}/history`, (h) => { historyCache = normArray(h); drawChart(); });
  bind(`${base}/processes`, (v) => { procCache = normArray(v.list); applyProc(); });
  bind(`${base}/screenshots`, renderScreenshots);
  bind(`${base}/browser`, (v) => { browserCache = normArray(v.entries); applyBrowser(); });
  bind(`${base}/activity`, renderActivity);
  bind(`${base}/live`, renderLive);
  bind(`${base}/commands`, renderCommands);
}

function bind(path, cb) {
  const r = ref(db, path);
  const handler = (snap) => cb(snap.val());
  onValue(r, handler);
  listeners.push({ r, cb: handler });
}

function renderMeta(meta) {
  meta = meta || {};
  const d = deviceList[currentDeviceId] || {};
  const info = d.info || {};
  $("device-title").textContent = meta.name || info.hostname || "Device";
  $("device-sub").textContent = "ID: " + currentDeviceId;
  const badge = $("online-badge");
  const online = isOnline(meta);
  const paused = !!meta.paused;
  if (paused) { badge.textContent = "paused"; badge.className = "badge"; }
  else { badge.textContent = online ? "online" : "offline"; badge.className = "badge " + (online ? "online" : "offline"); }
  if (info.os) $("meta-os").textContent = info.os;
  setSideStatus(online);
}

function setSideStatus(online) {
  const dot = $("sid-dot");
  const txt = $("sid-status-text");
  if (dot) dot.className = "status-dot " + (online ? "on" : "");
  if (txt) txt.textContent = online ? "Agent online" : "Agent offline";
}

function renderInfo(info) {
  info = info || {};
  if (info.os) $("meta-os").textContent = info.os;
  const rows = [
    ["Hostname", info.hostname],
    ["OS", info.os],
    ["User", info.username],
    ["Local IP", info.localIp],
    ["Processor", info.processor],
    ["CPU cores", info.cpuCoresPhysical ? `${info.cpuCoresPhysical} / ${info.cpuCoresLogical} logical` : ""],
    ["Total RAM", info.totalRamGb ? info.totalRamGb + " GB" : ""],
    ["Boot time", info.bootTime ? new Date(info.bootTime * 1000).toLocaleString() : ""],
  ].filter(([, v]) => v);
  $("info-grid").innerHTML = rows
    .map(([k, v]) => `<div class="row"><span>${k}</span><span>${escapeHtml(String(v))}</span></div>`)
    .join("");
}

function gaugeClass(p) {
  if (p >= 85) return "red";
  if (p >= 60) return "amber";
  return "green";
}

function sparkline(key, color) {
  const pts = historyCache.slice(-30).map((p) => p[key] || 0);
  if (pts.length < 2) return "";
  const w = 116, h = 40, step = w / (pts.length - 1);
  let d = "";
  pts.forEach((v, i) => {
    const x = (i * step).toFixed(1);
    const y = (h - (Math.max(0, Math.min(100, v)) / 100) * h).toFixed(1);
    d += (i ? " L" : "M") + x + " " + y;
  });
  const area = d + ` L${w} ${h} L0 ${h} Z`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${area}" fill="${color}" fill-opacity="0.14"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

function kpi(label, value, percent, sub, key, color) {
  return `<div class="card">
    ${key ? sparkline(key, color) : ""}
    <div class="label">${label}</div>
    <div class="value">${value}</div>
    <div class="bar ${gaugeClass(percent)}"><span style="width:${Math.min(percent, 100)}%"></span></div>
    ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}
  </div>`;
}

function updateHealth(cpu, ram, disks) {
  const el = $("health-pill");
  if (!el) return;
  const maxDisk = (disks || []).reduce((m, d) => Math.max(m, d.percent || 0), 0);
  const worst = Math.max(cpu, ram, maxDisk);
  if (worst >= 90) { el.className = "health-pill bad"; el.textContent = "High Load"; }
  else if (worst >= 75) { el.className = "health-pill warn"; el.textContent = "Elevated"; }
  else { el.className = "health-pill"; el.textContent = "System Healthy"; }
}

function renderStats(s) {
  s = s || {};
  if (!s.timestamp) return;
  const cpu = s.cpuPercent || 0;
  const ram = s.ramPercent || 0;
  const cpuSub = [s.cpuModel, s.cpuCores ? s.cpuCores + " cores" : ""].filter(Boolean).join(" \u00b7 ");
  $("stat-cards").innerHTML = `
    ${kpi("CPU", cpu.toFixed(0) + "%", cpu, cpuSub, "cpu", "#2e90fa")}
    ${kpi("Memory", ram.toFixed(0) + "%", ram, `${s.ramUsedGb || 0} / ${s.ramTotalGb || 0} GB`, "ram", "#9b7df0")}
    <div class="card">
      <div class="label">Uptime</div>
      <div class="value">${fmtUptime(s.uptimeSeconds)}</div>
      <div class="sub">${s.activeWindow ? "Active: " + escapeHtml(truncate(s.activeWindow, 30)) : "No active window"}</div>
    </div>
    ${s.battery ? `<div class="card">
      <div class="label">Battery</div>
      <div class="value">${s.battery.percent || 0}%</div>
      <div class="bar ${gaugeClass(s.battery.percent || 0)}"><span style="width:${Math.min(s.battery.percent || 0, 100)}%"></span></div>
      <div class="sub">${s.battery.plugged ? "Charging" : "On battery"}</div>
    </div>` : ""}
  `;
  $("meta-uptime").textContent = fmtUptime(s.uptimeSeconds);
  $("meta-active").textContent = s.activeWindow ? truncate(s.activeWindow, 28) : "\u2014";
  $("legend-cpu").textContent = cpu.toFixed(0) + "%";
  $("legend-ram").textContent = ram.toFixed(0) + "%";
  updateHealth(cpu, ram, s.disks);
  $("disks").innerHTML =
    (s.disks || [])
      .map(
        (d) => `<div class="card" style="margin-bottom:10px">
        <div class="label">${escapeHtml(d.device)} (${escapeHtml(d.mountpoint)})</div>
        <div class="bar ${gaugeClass(d.percent)}" style="margin-top:10px"><span style="width:${d.percent}%"></span></div>
        <div class="muted" style="margin-top:6px;font-size:12px">${d.usedGb} / ${d.totalGb} GB used (${d.percent}%)</div>
      </div>`
      )
      .join("") || '<p class="empty">No disk info.</p>';
}

function chartPoints() {
  const now = Date.now();
  let pts = historyCache.filter((p) => !p.t || p.t >= now - chartRange * 1000);
  if (pts.length < 2) pts = historyCache.slice(-60);
  return pts.slice(-240);
}

/* ---------- Chart ---------- */
function drawChart() {
  const canvas = $("chart");
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = 220;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pts = chartPoints();
  const pad = { l: 30, r: 8, t: 10, b: 16 };
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;

  ctx.strokeStyle = "rgba(255,255,255,.07)";
  ctx.fillStyle = "#8b93ad";
  ctx.font = "10px Inter, sans-serif";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (h * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + w, y);
    ctx.stroke();
    ctx.fillText(String(100 - i * 25), 6, y + 3);
  }

  if (pts.length < 2) {
    ctx.fillStyle = "#8b93ad";
    ctx.fillText("Waiting for data...", pad.l + 8, pad.t + h / 2);
    return;
  }

  const xAt = (i) => pad.l + (w * i) / (pts.length - 1);
  const yAt = (v) => pad.t + h - (Math.max(0, Math.min(100, v)) / 100) * h;

  const series = (key, color, fill) => {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p[key] || 0);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.lineTo(xAt(pts.length - 1), pad.t + h);
    ctx.lineTo(xAt(0), pad.t + h);
    ctx.closePath();
    const area = ctx.createLinearGradient(0, pad.t, 0, pad.t + h);
    area.addColorStop(0, fill);
    area.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = area;
    ctx.fill();

    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p[key] || 0);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };
  series("cpu", "#2e90fa", "rgba(46,144,250,.18)");
  series("ram", "#9b7df0", "rgba(155,125,240,.16)");
}

window.addEventListener("resize", drawChart);

/* ---------- Processes ---------- */
function applyProc() {
  let list = procCache.slice();
  const f = procFilter.toLowerCase();
  if (f) {
    list = list.filter(
      (p) =>
        (p.name || "").toLowerCase().includes(f) ||
        (p.username || "").toLowerCase().includes(f) ||
        String(p.pid).includes(f)
    );
  }
  list.sort((a, b) => cmp(a[procSort.key], b[procSort.key]) * procSort.dir);
  $("process-body").innerHTML =
    list
      .map(
        (p) => `<tr><td>${p.pid}</td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.username || "")}</td>
        <td>${(p.cpuPercent || 0).toFixed(1)}</td><td>${(p.memMb || 0).toFixed(1)}</td></tr>`
      )
      .join("") || '<tr><td colspan="5" class="empty">No processes reported.</td></tr>';
}

/* ---------- Browser ---------- */
function applyBrowser() {
  let list = browserCache.slice();
  const f = browserFilter.toLowerCase();
  if (f) {
    list = list.filter(
      (e) =>
        (e.title || "").toLowerCase().includes(f) ||
        (e.url || "").toLowerCase().includes(f) ||
        (e.browser || "").toLowerCase().includes(f)
    );
  }
  list.sort((a, b) => cmp(a[browserSort.key], b[browserSort.key]) * browserSort.dir);
  $("browser-body").innerHTML =
    list
      .map(
        (e) => `<tr><td>${e.time ? new Date(e.time).toLocaleString() : ""}</td><td>${escapeHtml(e.browser)}</td>
        <td>${escapeHtml(truncate(e.title || "", 60))}</td>
        <td><a href="${escapeUrl(e.url)}" target="_blank" rel="noopener">${escapeHtml(truncate(e.url, 70))}</a></td></tr>`
      )
      .join("") || '<tr><td colspan="4" class="empty">No browser history yet.</td></tr>';
}

/* ---------- Screenshots + lightbox ---------- */
function renderScreenshots(shots) {
  shots = shots || {};
  shotsCache = Object.values(shots).filter((s) => s && s.image).sort((a, b) => b.time - a.time);
  $("screenshots").innerHTML =
    shotsCache
      .map(
        (s, i) => `<div class="shot">
        <img src="data:image/jpeg;base64,${s.image}" data-index="${i}" alt="screenshot" />
        <div class="cap">${new Date(s.time).toLocaleString()}<br>${escapeHtml(truncate(s.window || "", 60))}</div>
      </div>`
      )
      .join("") || '<p class="empty">No screenshots yet.</p>';
  $("screenshots").querySelectorAll("img").forEach((img) => {
    img.onclick = () => openLightbox(Number(img.dataset.index));
  });
}

let lbIndex = 0;
function openLightbox(i) {
  if (!shotsCache.length) return;
  lbIndex = (i + shotsCache.length) % shotsCache.length;
  const s = shotsCache[lbIndex];
  $("lb-img").src = "data:image/jpeg;base64," + s.image;
  $("lb-download").href = "data:image/jpeg;base64," + s.image;
  $("lb-download").download = `screenshot-${s.time}.jpg`;
  $("lb-caption").textContent = `${lbIndex + 1} / ${shotsCache.length}  |  ${new Date(s.time).toLocaleString()}  |  ${truncate(s.window || "", 60)}`;
  $("lightbox").classList.remove("hidden");
}
function closeLightbox() { $("lightbox").classList.add("hidden"); }

$("lb-close").onclick = closeLightbox;
$("lb-prev").onclick = (e) => { e.stopPropagation(); openLightbox(lbIndex - 1); };
$("lb-next").onclick = (e) => { e.stopPropagation(); openLightbox(lbIndex + 1); };
$("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
document.addEventListener("keydown", (e) => {
  if ($("lightbox").classList.contains("hidden")) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft") openLightbox(lbIndex - 1);
  if (e.key === "ArrowRight") openLightbox(lbIndex + 1);
});

/* ---------- Activity ---------- */
function renderActivity(data) {
  const items = normArray(data).sort((a, b) => b.time - a.time);
  $("activity-list").innerHTML =
    items
      .map((a) => `<li><span>${escapeHtml(a.title || "")}</span><span>${new Date(a.time).toLocaleTimeString()}</span></li>`)
      .join("") || '<li class="empty">No activity yet.</li>';
}

/* ---------- Remote ---------- */
function sendCommand(type, args) {
  if (!currentDeviceId) return;
  push(ref(db, `devices/${currentDeviceId}/commands`), {
    type,
    args: args || {},
    status: "pending",
    createdAt: Date.now(),
  });
}

let liveFrames = [];

function renderLive(data) {
  const has = data && data.image;
  document.querySelectorAll("img.live-img").forEach((img) => {
    if (has) { img.src = "data:image/jpeg;base64," + data.image; img.style.display = "block"; }
    else { img.removeAttribute("src"); img.style.display = "none"; }
  });

  const snap = $("sess-img");
  if (snap && !rtcActive()) {
    if (has) { snap.src = "data:image/jpeg;base64," + data.image; snap.style.display = "block"; }
    else { snap.removeAttribute("src"); snap.style.display = "none"; }
  }
  const sessEmpty = $("sess-empty");
  if (sessEmpty) sessEmpty.style.display = (!rtcActive() && !has) ? "block" : "none";

  if (has) {
    liveOn = true;
    const t = new Date(data.time).toLocaleTimeString();
    if ($("live-status")) $("live-status").textContent = "live · " + t;
    if ($("sess-status")) $("sess-status").textContent = "· " + (data.window || "") + " · " + t;
    liveFrames.push(data.time);
    liveFrames = liveFrames.filter((x) => data.time - x < 10000);
    if (liveFrames.length > 1 && $("sess-fps")) {
      const span = (liveFrames[liveFrames.length - 1] - liveFrames[0]) / 1000;
      const fps = span > 0 ? (liveFrames.length - 1) / span : 0;
      const age = ((Date.now() - data.time) / 1000).toFixed(1);
      $("sess-fps").textContent = `${fps.toFixed(1)} fps · frame age ${age}s`;
    }
  } else {
    if ($("live-status")) $("live-status").textContent = "stopped";
    if ($("sess-status") && !rtcActive()) $("sess-status").textContent = "stopped";
    liveFrames = [];
  }

  const label = liveOn ? "Stop live" : "Start live";
  if ($("live-toggle")) $("live-toggle").textContent = label;
  if ($("sess-live")) $("sess-live").textContent = label;
}

function setLive(on) {
  if (!currentDeviceId) return;
  liveOn = on;
  liveFrames = [];
  sendCommand(on ? "live_start" : "live_stop");
  const label = on ? "Stop live" : "Start live";
  if ($("live-toggle")) $("live-toggle").textContent = label;
  if ($("sess-live")) $("sess-live").textContent = label;
}

const QUALITY = {
  low:    { liveScale: 0.3, liveQuality: 35, liveIntervalSeconds: 2 },
  medium: { liveScale: 0.5, liveQuality: 50, liveIntervalSeconds: 1.5 },
  high:   { liveScale: 0.7, liveQuality: 65, liveIntervalSeconds: 1 },
};

function openSession() {
  if (!currentDeviceId) return;
  $("sess-title").textContent = deviceList[currentDeviceId]?.meta?.name || "Device";
  $("session").classList.remove("hidden");
}
function closeSession() {
  rtcDisconnect();
  $("session").classList.add("hidden");
  if (document.fullscreenElement) document.exitFullscreen();
}

/* ---------- WebRTC remote control ---------- */
let rtcPc = null;
let rtcDc = null;
let rtcSession = null;
let rtcListeners = [];
let rtcMode = "session";

function rtcActive() {
  return rtcPc && !["closed", "failed"].includes(rtcPc.connectionState);
}

function rtcTargetVideo() {
  return rtcMode === "controller" ? $("ctl-video") : $("rtc-video");
}

function rtcStatus(state) {
  const on = rtcActive();
  if ($("rtc-status")) $("rtc-status").textContent = "webrtc: " + state;
  if ($("sess-rtc")) $("sess-rtc").textContent = rtcPc ? "Disconnect HD" : "Connect HD";
  const vid = $("rtc-video");
  const snap = $("sess-img");
  const empty = $("sess-empty");
  if (vid) vid.style.display = on && rtcMode === "session" ? "block" : "none";
  if (snap) snap.style.display = on ? "none" : (snap.getAttribute("src") ? "block" : "none");
  if (empty) empty.style.display = on ? "none" : (liveFrames.length ? "none" : "block");
  const cv = $("ctl-video");
  const cempty = $("ctl-empty");
  if (cv) cv.style.display = on && rtcMode === "controller" ? "block" : "none";
  if (cempty) cempty.style.display = on && rtcMode === "controller" ? "none" : "block";
  if ($("ctl-connect")) $("ctl-connect").textContent = rtcPc ? "Disconnect" : "Connect";
  if ($("ctl-status")) $("ctl-status").textContent = rtcPc ? "webrtc: " + state : "disconnected";
}

async function rtcConnect(mode = "session") {
  if (!currentDeviceId) return;
  if (rtcPc) await rtcDisconnect();
  rtcMode = mode;
  const base = `devices/${currentDeviceId}/rtc`;
  rtcSession = String(Date.now());
  if (mode === "session") $("session").classList.remove("hidden");
  await Promise.all(["offer", "answer", "hostCand", "agentCand", "status"].map((k) => remove(ref(db, `${base}/${k}`)).catch(() => {})));

  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  rtcPc = pc;
  pc.addTransceiver("video", { direction: "recvonly" });
  const dc = pc.createDataChannel("control");
  rtcDc = dc;
  dc.onopen = () => rtcStatus("connected");

  pc.onicecandidate = (e) => {
    if (e.candidate) push(ref(db, `${base}/hostCand`), { ...e.candidate.toJSON(), session: rtcSession });
  };
  pc.ontrack = (e) => {
    const vid = rtcTargetVideo();
    if (vid) { vid.srcObject = e.streams[0]; vid.play().catch(() => {}); }
  };
  pc.onconnectionstatechange = () => {
    rtcStatus(pc.connectionState);
    if (["failed", "disconnected"].includes(pc.connectionState)) rtcDisconnect();
  };

  const bindRtc = (key, cb) => {
    const r = ref(db, `${base}/${key}`);
    const h = (snap) => cb(snap.val());
    onValue(r, h);
    rtcListeners.push({ r, h });
  };
  bindRtc("answer", (a) => {
    if (a && String(a.session) === rtcSession && pc.signalingState === "have-local-offer") {
      pc.setRemoteDescription({ type: "answer", sdp: a.sdp }).catch(() => {});
    }
  });
  bindRtc("agentCand", (cands) => {
    Object.values(cands || {}).forEach((c) => {
      if (c && String(c.session) === rtcSession && c.candidate) {
        pc.addIceCandidate({ candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex }).catch(() => {});
      }
    });
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await set(ref(db, `${base}/offer`), {
    sdp: pc.localDescription.sdp, type: "offer", session: rtcSession, createdAt: Date.now(),
  });
  rtcStatus("connecting");
}

function rtcDisconnect() {
  rtcListeners.forEach(({ r, h }) => off(r, "value", h));
  rtcListeners = [];
  if (rtcPc) { try { rtcPc.close(); } catch (e) {} rtcPc = null; }
  rtcDc = null;
  const vid = $("rtc-video");
  if (vid) vid.srcObject = null;
  const cv = $("ctl-video");
  if (cv) cv.srcObject = null;
  if (currentDeviceId) remove(ref(db, `devices/${currentDeviceId}/rtc/offer`)).catch(() => {});
  rtcSession = null;
  rtcStatus("idle");
}

const rtcVid = $("rtc-video");
if (rtcVid) {
  rtcVid.tabIndex = 0;
  const map = (e) => {
    const r = rtcVid.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const send = (o) => { if (rtcDc && rtcDc.readyState === "open") rtcDc.send(JSON.stringify(o)); };
  rtcVid.addEventListener("mousemove", (e) => { const p = map(e); send({ t: "move", x: p.x, y: p.y }); });
  rtcVid.addEventListener("mousedown", (e) => { rtcVid.focus(); const p = map(e); send({ t: "down", button: e.button, x: p.x, y: p.y }); e.preventDefault(); });
  rtcVid.addEventListener("mouseup", (e) => { send({ t: "up", button: e.button }); e.preventDefault(); });
  rtcVid.addEventListener("contextmenu", (e) => e.preventDefault());
  rtcVid.addEventListener("wheel", (e) => { send({ t: "wheel", dx: Math.sign(e.deltaX), dy: Math.sign(e.deltaY) }); e.preventDefault(); }, { passive: false });
  rtcVid.addEventListener("keydown", (e) => { send({ t: "key", action: "down", key: e.key }); e.preventDefault(); });
  rtcVid.addEventListener("keyup", (e) => { send({ t: "key", action: "up", key: e.key }); e.preventDefault(); });
}

/* ---------- Controller (touch gamepad) ---------- */
function dcSend(obj) {
  if (rtcDc && rtcDc.readyState === "open") rtcDc.send(JSON.stringify(obj));
}

document.querySelectorAll("#panel-controller .pad-btn").forEach((btn) => {
  const key = btn.dataset.key;
  const press = (e) => {
    e.preventDefault();
    btn.classList.add("pressed");
    dcSend({ t: "key", action: "down", key });
    try { btn.setPointerCapture(e.pointerId); } catch (_) {}
  };
  const release = (e) => {
    if (e) e.preventDefault();
    btn.classList.remove("pressed");
    dcSend({ t: "key", action: "up", key });
  };
  btn.addEventListener("pointerdown", press);
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("pointerleave", release);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
});

if ($("ctl-connect")) $("ctl-connect").onclick = () => { if (rtcPc) rtcDisconnect(); else rtcConnect("controller"); };

function renderCommands(data) {
  const items = normArray(data).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 15);
  $("command-body").innerHTML =
    items
      .map((c) => {
        const cls = c.status === "done" ? "ok" : c.status === "failed" ? "bad" : "pend";
        return `<tr><td>${c.createdAt ? new Date(c.createdAt).toLocaleTimeString() : ""}</td>
          <td>${escapeHtml(c.type || "")}</td>
          <td><span class="pill ${cls}">${escapeHtml(c.status || "pending")}</span></td>
          <td>${escapeHtml(truncate(c.result || "", 60))}</td></tr>`;
      })
      .join("") || '<tr><td colspan="4" class="empty">No commands sent yet.</td></tr>';
}

document.querySelectorAll("#panel-remote .rbtn[data-cmd]").forEach((btn) => {
  btn.onclick = () => {
    const cmd = btn.dataset.cmd;
    if (!currentDeviceId) return;
    if (cmd === "message") {
      sendCommand("message", { title: $("msg-title").value, text: $("msg-text").value });
      $("msg-text").value = "";
    } else if (cmd === "shutdown" || cmd === "restart") {
      const dev = deviceList[currentDeviceId]?.meta?.name || "this PC";
      if (confirm(`${cmd.toUpperCase()} ${dev}? This will affect the PC immediately.`)) sendCommand(cmd);
    } else {
      sendCommand(cmd);
    }
  };
});

$("live-toggle").onclick = () => setLive(!liveOn);
$("live-img").onclick = openSession;
$("open-session").onclick = openSession;
$("sess-close").onclick = closeSession;
$("sess-live").onclick = () => setLive(!liveOn);
$("sess-rtc").onclick = () => { if (rtcPc) rtcDisconnect(); else rtcConnect(); };
$("sess-shot").onclick = () => sendCommand("screenshot_now");
$("sess-full").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("session").requestFullscreen?.();
};
$("sess-quality").onchange = (e) => {
  if (currentDeviceId) sendCommand("settings", QUALITY[e.target.value]);
};

document.addEventListener("keydown", (e) => {
  if ($("session").classList.contains("hidden")) return;
  if (e.key === "Escape" && !document.fullscreenElement) closeSession();
});

/* ---------- Tabs / menu ---------- */
function activateTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + name));
  const meta = $("device-meta");
  if (meta) meta.style.display = name === "devices" ? "none" : "";
  if (name === "overview") requestAnimationFrame(drawChart);
}

$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (btn) activateTab(btn.dataset.tab);
});

document.querySelectorAll("#chart-range button").forEach((b) => {
  b.onclick = () => {
    chartRange = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "24h": 86400 }[b.dataset.range] || 60;
    document.querySelectorAll("#chart-range button").forEach((x) => x.classList.toggle("active", x === b));
    drawChart();
  };
});

function closeMenu() {
  $("sidebar").classList.remove("open");
  $("backdrop").classList.add("hidden");
}
$("menu-btn").onclick = () => {
  $("sidebar").classList.toggle("open");
  $("backdrop").classList.toggle("hidden", !$("sidebar").classList.contains("open"));
};
$("backdrop").onclick = closeMenu;

/* ---------- Search / sort wiring ---------- */
$("device-search").addEventListener("input", (e) => { deviceFilter = e.target.value.toLowerCase(); renderDeviceList(); });
$("proc-search").addEventListener("input", (e) => { procFilter = e.target.value; applyProc(); });
$("browser-search").addEventListener("input", (e) => { browserFilter = e.target.value; applyBrowser(); });

function wireSort(tableSel, state, redraw) {
  document.querySelectorAll(`${tableSel} th[data-key]`).forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.key;
      if (state.key === key) state.dir *= -1;
      else { state.key = key; state.dir = key === "time" ? -1 : 1; }
      document.querySelectorAll(`${tableSel} th`).forEach((t) => t.classList.remove("sorted-asc", "sorted-desc"));
      th.classList.add(state.dir === 1 ? "sorted-asc" : "sorted-desc");
      redraw();
    };
  });
}
wireSort("#panel-processes", procSort, applyProc);
wireSort("#panel-browser", browserSort, applyBrowser);
document.querySelector("#panel-browser th[data-key='time']").classList.add("sorted-desc");
document.querySelector("#panel-processes th[data-key='memMb']").classList.add("sorted-desc");

/* ---------- Helpers ---------- */
function normArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null);
  if (typeof v === "object") return Object.values(v).filter((x) => x != null);
  return [];
}

function cmp(a, b) {
  if (typeof a === "string" || typeof b === "string") {
    return String(a || "").localeCompare(String(b || ""));
  }
  return (Number(a) || 0) - (Number(b) || 0);
}

function fmtUptime(sec) {
  if (!sec) return "-";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtRelative(ts) {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 60000) return Math.round(diff / 1000) + "s ago";
  if (diff < 3600000) return Math.round(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.round(diff / 3600000) + "h ago";
  return Math.round(diff / 86400000) + "d ago";
}

function truncate(str, n) {
  str = String(str || "");
  return str.length > n ? str.slice(0, n - 1) + "\u2026" : str;
}

function nameHue(str) {
  let h = 0;
  const s = String(str || "?");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function initials(str) {
  const parts = String(str || "?").trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const AVATAR_COLORS = ["#3b6fb5", "#4c6f9c", "#5b6cab", "#6b5b95", "#456b8a", "#4a7c6f", "#7a6a3f", "#8a5a5a"];

function avatarHtml(name, online) {
  const c = AVATAR_COLORS[nameHue(name) % AVATAR_COLORS.length];
  return `<span class="avatar" style="background:${c}">${escapeHtml(initials(name))}<span class="presence ${online ? "on" : ""}"></span></span>`;
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeUrl(str) {
  const s = String(str || "");
  return /^https?:\/\//i.test(s) ? escapeHtml(s) : "#";
}
