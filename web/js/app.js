// Dashboard runtime: render the active page's grid, rotate through pages in
// slideshow mode, and live-reload over SSE with no page refresh.
import * as registry from "./widgets/index.js";
import { el } from "./widgets/dom.js";
import { initDevices, getPrefs, onDevicePrefs } from "./device.js";

const grid = document.getElementById("grid");
const dots = document.getElementById("pagedots");
let active = []; // [{ widget, card, plugin, handle, refreshTimer, scheduleTimer }]

// page/rotation state
let config = null;
let order = [];          // ordered list of ALL Page objects
let visible = [];        // pages this display currently shows (device prefs + schedule)
let pageIndex = 0;       // index into `visible`
let rotationTimer = null;
let paused = false;      // user tapped a dot → stop auto-advance

// Preview mode (admin's live mini-preview iframe): ?page=<id> locks to one page,
// no rotation, no device identity (so previews don't register as displays).
const urlParams = new URLSearchParams(location.search);
const previewPageId = urlParams.get("page");
const isPreview = previewPageId != null || urlParams.get("preview") === "1";
if (isPreview) document.body.classList.add("preview");

async function loadConfig() {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`config ${res.status}`);
  return res.json();
}

// Config-provided base metrics; the per-device scale multiplies these (see
// applyScale). Kept in module scope so a device-prefs change can re-apply them
// without re-fetching the config.
let baseRowPx = 90;
let baseGapPx = 12;

function applySettings(settings) {
  document.title = settings.title || "Pi Dashboard";
  const root = document.documentElement;
  root.style.setProperty("--columns", settings.columns || 12);
  root.style.setProperty("--accent", settings.theme?.accent || "#4aa3ff");
  root.dataset.theme = settings.theme?.mode || "dark";
  baseRowPx = settings.rowHeightPx || 90;
  baseGapPx = settings.gapPx || 12;
  applyScale();
}

// Fold the per-device overlay onto the shared base: uiScale shrinks/grows the
// whole layout + text uniformly; fontScale trims text on top of that.
function applyScale() {
  const { uiScale, fontScale } = getPrefs();
  const root = document.documentElement;
  root.style.setProperty("--row-height", `${baseRowPx * uiScale}px`);
  root.style.setProperty("--gap", `${baseGapPx * uiScale}px`);
  root.style.setProperty("--font-scale", uiScale * fontScale);
}

function teardown() {
  for (const a of active) {
    clearInterval(a.refreshTimer);
    clearInterval(a.scheduleTimer);
    a.plugin?.destroy?.(a.handle);
  }
  active = [];
  grid.replaceChildren();
}

// ---- page visibility: device assignment + page schedule ----------------------

// Same semantics as a widget schedule: days 0=Mon, HH:MM window (may wrap).
function inWindow(s, now = new Date()) {
  if (!s?.enabled) return true;
  const dow = (now.getDay() + 6) % 7;
  if (s.days?.length && !s.days.includes(dow)) return false;
  if (s.start && s.end) {
    const cur = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = s.start.split(":").map(Number);
    const [eh, em] = s.end.split(":").map(Number);
    const start = sh * 60 + sm, end = eh * 60 + em;
    return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
  }
  return true;
}

function computeVisible() {
  let v = order;
  if (previewPageId) {
    v = order.filter((p) => p.id === previewPageId);
    return v.length ? v : order.slice(0, 1);
  }
  // device page assignment (empty = all pages)
  const assigned = getPrefs().pages || [];
  if (assigned.length) {
    const keep = v.filter((p) => assigned.includes(p.id));
    if (keep.length) v = keep;               // all-filtered → fall back to everything
  }
  // page schedules
  const scheduled = v.filter((p) => inWindow(p.schedule));
  return scheduled.length ? scheduled : v;    // never leave the screen blank
}

// Re-evaluate visibility (device prefs changed, schedule window crossed).
// Re-renders only when the visible set actually changed.
function refreshVisibility() {
  if (!config) return;
  const cur = visible.map((p) => p.id).join("|");
  const next = computeVisible();
  if (next.map((p) => p.id).join("|") === cur) return;
  const activeId = visible[pageIndex]?.id;
  visible = next;
  const keep = visible.findIndex((p) => p.id === activeId);
  pageIndex = keep >= 0 ? keep : 0;
  buildDots();
  renderPage(visible[pageIndex]);
  scheduleRotation();
}

// ---- whole-config entry point (initial load + every SSE config-changed) -----
function show(cfg) {
  config = cfg;
  applySettings(cfg.settings || {});
  const pages = cfg.pages || [];
  const rotation = cfg.rotation || {};
  // resolve page order (explicit ids first, then any leftovers)
  if (rotation.order?.length) {
    const byId = new Map(pages.map((p) => [p.id, p]));
    order = rotation.order.map((id) => byId.get(id)).filter(Boolean);
    for (const p of pages) if (!order.includes(p)) order.push(p);
  } else {
    order = [...pages];
  }
  paused = false;
  visible = computeVisible();
  pageIndex = Math.min(pageIndex, Math.max(0, visible.length - 1));
  buildDots();
  if (visible.length) renderPage(visible[pageIndex]);
  else { teardown(); grid.appendChild(el("div", { class: "widget-error" }, "No pages configured")); }
  scheduleRotation();
}

let rendering = false; // pause the value-pulse observer during full rebuilds

async function renderPage(page) {
  rendering = true;
  // crossfade: fade the old grid out before rebuilding (skipped by reduced-motion CSS)
  if (grid.childElementCount) {
    grid.classList.add("page-out");
    await new Promise((r) => setTimeout(r, 180));
  }
  teardown();
  grid.classList.remove("page-out");
  let cardIndex = 0;
  for (const widget of page.widgets || []) {
    if (widget.enabled === false) continue;
    const plugin = registry.get(widget.type);
    const card = el("div", { class: "card card-enter", "data-id": widget.id });
    card.style.animationDelay = `${Math.min(cardIndex++ * 45, 450)}ms`;
    card.addEventListener("animationend", () => card.classList.remove("card-enter"), { once: true });
    card.style.gridColumn = `${(widget.grid?.x ?? 0) + 1} / span ${widget.grid?.w ?? 3}`;
    card.style.gridRow = `${(widget.grid?.y ?? 0) + 1} / span ${widget.grid?.h ?? 3}`;
    if (widget.title) card.appendChild(el("div", { class: "card-title" }, widget.title));
    const body = el("div", { class: "card-body" });
    card.appendChild(body);
    grid.appendChild(card);

    const entry = { widget, card, plugin, handle: null };
    active.push(entry);

    if (!plugin) {
      body.appendChild(el("div", { class: "widget-error" }, `Unsupported widget type: ${widget.type}`));
      continue;
    }
    try {
      entry.handle = await plugin.mount(body, widget, {});
    } catch (err) {
      body.appendChild(el("div", { class: "widget-error" }, `Failed: ${err.message}`));
      continue;
    }
    if (widget.refreshSeconds && plugin.refresh) {
      entry.refreshTimer = setInterval(
        () => plugin.refresh(entry.handle, widget),
        widget.refreshSeconds * 1000
      );
    }
    if (widget.schedule?.enabled) {
      applySchedule(entry);
      entry.scheduleTimer = setInterval(() => applySchedule(entry), 30000);
    }
  }
  rendering = false;
}

// ---- page rotation (slideshow mode) -----------------------------------------
function scheduleRotation() {
  clearTimeout(rotationTimer);
  const rotation = config?.rotation || {};
  if (isPreview || paused || !rotation.enabled || visible.length < 2) return;
  const page = visible[pageIndex];
  const secs = page.durationSeconds || rotation.defaultDurationSeconds || 30;
  rotationTimer = setTimeout(() => goToPage((pageIndex + 1) % visible.length, false), secs * 1000);
}

function goToPage(i, fromUser) {
  pageIndex = i;
  if (fromUser) paused = true; // tapping a dot stops auto-advance
  renderPage(visible[pageIndex]);
  updateDots();
  scheduleRotation();
}

function buildDots() {
  if (!dots) return;
  dots.replaceChildren();
  if (visible.length < 2) return;
  visible.forEach((p, i) => {
    const d = el("button", { class: "pagedot", title: p.name, onclick: () => goToPage(i, true) });
    dots.appendChild(d);
  });
  updateDots();
}

function updateDots() {
  if (!dots) return;
  [...dots.children].forEach((d, i) => d.classList.toggle("active", i === pageIndex));
}

function applySchedule(entry) {
  const show = inWindow(entry.widget.schedule);
  entry.card.classList.toggle("scheduled-hidden", !show);
  const plugin = entry.plugin;
  if (!show) plugin?.suspend?.(entry.handle);
  else plugin?.resume?.(entry.handle);
}

// ---- alert banners (SSE `alert` events from the server's alert engine) --------
let alertHost = null;
const alertTimers = new Map(); // id -> auto-dismiss timeout

function initAlerts() {
  alertHost = el("div", { id: "alerts" });
  document.body.appendChild(alertHost);
  fetch("/api/alerts").then((r) => r.json())
    .then((d) => (d.alerts || []).forEach(showAlert))
    .catch(() => {});
}

function showAlert(a) {
  if (!alertHost || !a?.id) return;
  const existing = alertHost.querySelector(`[data-alert="${CSS.escape(a.id)}"]`);
  // Settings change re-broadcasts the same id with a new expiresAt — reset timer.
  if (existing) {
    clearTimeout(alertTimers.get(a.id));
    alertTimers.delete(a.id);
  } else {
    const banner = el("div", { class: `alert alert-${a.severity || "info"}`, "data-alert": a.id }, [
      el("div", { class: "alert-text" }, [
        el("div", { class: "alert-title" }, a.title || "Alert"),
        a.message ? el("div", { class: "alert-msg" }, a.message) : null,
      ]),
      el("button", { class: "alert-close", title: "Dismiss", onclick: () => dismissAlert(a.id, { notifyServer: true }) }, "✕"),
    ]);
    alertHost.prepend(banner);
  }
  if (a.expiresAt == null) return;
  const ttl = a.expiresAt * 1000 - Date.now();
  if (ttl <= 0) {
    dismissAlert(a.id); // already past — server prune / active() filter is source of truth
    return;
  }
  // Local timer only; server prune broadcasts alert-cleared so clocks can't clear early.
  alertTimers.set(a.id, setTimeout(() => dismissAlert(a.id), ttl));
}

function dismissAlert(id, { notifyServer = false } = {}) {
  clearTimeout(alertTimers.get(id));
  alertTimers.delete(id);
  const banner = alertHost?.querySelector(`[data-alert="${CSS.escape(id)}"]`);
  if (banner) {
    banner.classList.add("alert-out");
    banner.addEventListener("animationend", () => banner.remove(), { once: true });
    setTimeout(() => banner.remove(), 600); // reduced-motion fallback
  }
  // ✕ must clear the server copy — otherwise reload / other displays bring it
  // back (especially when TTL is 0 = keep until dismissed).
  if (notifyServer) {
    fetch(`/api/alerts/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }
}

// ---- value-change pulse: any widget's updated number/text briefly glows -------
// One central MutationObserver instead of per-widget code. The clock is excluded
// (it changes every second) and full page rebuilds are ignored via `rendering`.
const lastPulse = new WeakMap();

function initValuePulse() {
  const mo = new MutationObserver((muts) => {
    if (rendering) return;
    for (const m of muts) {
      const node = m.target.nodeType === Node.TEXT_NODE ? m.target.parentElement : m.target;
      if (!(node instanceof Element)) continue;
      if (node.closest(".clock") || node.closest("#alerts")) continue;
      const target = node.closest(".card-body") ? node : null;
      if (!target) continue;
      const now = performance.now();
      if ((lastPulse.get(target) || 0) > now - 2000) continue; // throttle per element
      lastPulse.set(target, now);
      target.classList.remove("value-tick");
      void target.offsetWidth; // restart the animation
      target.classList.add("value-tick");
    }
  });
  mo.observe(grid, { subtree: true, childList: true, characterData: true });
}

function refreshAll() {
  for (const a of active) a.plugin?.refresh?.(a.handle, a.widget);
}

// ---- new-build detection: hard-reload when the server ships new assets -------
// SSE reloads config but NOT JS modules, so a long-lived kiosk would keep running
// stale code after a rebuild. We compare the server's asset version on load and
// on every SSE event; with no-cache headers a reload then fetches fresh modules.
let assetVersion = null;
async function checkVersion() {
  try {
    const r = await fetch("/api/version", { cache: "no-store" });
    const { version } = await r.json();
    if (assetVersion && version !== assetVersion) { location.reload(); return; }
    assetVersion = version;
  } catch { /* offline — try again on the next event */ }
}

// ---- SSE live-reload with exponential backoff -------------------------------
let backoff = 1000;
function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("connected", () => { backoff = 1000; setStatus(true); checkVersion(); });
  es.addEventListener("config-changed", async () => {
    await checkVersion();
    try { show(await loadConfig()); } catch (e) { console.error(e); }
  });
  es.addEventListener("refresh", () => refreshAll());
  es.addEventListener("device-prefs", (e) => {
    try { onDevicePrefs(JSON.parse(e.data)); } catch { /* ignore malformed */ }
  });
  es.addEventListener("alert", (e) => {
    try { showAlert(JSON.parse(e.data)); } catch { /* ignore malformed */ }
  });
  es.addEventListener("alert-cleared", (e) => {
    try { dismissAlert(JSON.parse(e.data).id); } catch { /* ignore malformed */ }
  });
  es.onerror = () => {
    setStatus(false);
    es.close();
    setTimeout(connectEvents, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
}

function setStatus(ok) {
  const dot = document.getElementById("status");
  if (dot) dot.className = ok ? "online" : "offline";
}

(async function start() {
  // Set up per-device scaling first (reads cached prefs synchronously) so the
  // first render already uses this screen's size, not the shared default.
  // Skipped in preview mode so the admin's mini-preview doesn't register as a
  // display or inherit some device's scale.
  if (!isPreview) {
    initDevices({ onChange: () => { applyScale(); refreshVisibility(); } });
  }
  try {
    show(await loadConfig());
  } catch (e) {
    grid.appendChild(el("div", { class: "widget-error" }, `Could not load config: ${e.message}`));
  }
  connectEvents();
  initAlerts();
  initValuePulse();
  // page schedules cross their window boundaries without any other trigger
  setInterval(refreshVisibility, 30000);
})();
