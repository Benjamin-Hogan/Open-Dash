// Per-device display scaling — the layer the shared server config can't provide.
//
// Every display fetches the SAME /api/config, so `columns`/`rowHeightPx`/fonts
// are global. This module adds an overlay that lives on THIS device: a uiScale
// (scales layout metrics + text together to fit the screen) and a fontScale
// (text-only trim). Identity is a random id in localStorage; values are stored
// server-side per device (so the admin can see & tune each screen) and cached
// locally so a boot applies instantly before the network answers.
//
// app.js owns the actual CSS application (it knows the config's base metrics),
// so we just hold state and call back on every change.

const LS_ID = "dash.deviceId";
const LS_NAME = "dash.deviceName";
const LS_PREFS = "dash.prefs";

const UI_MIN = 0.5, UI_MAX = 2.0, UI_STEP = 0.05;
const FONT_MIN = 0.6, FONT_MAX = 1.8, FONT_STEP = 0.05;

let deviceId = "";
let deviceName = "";
let prefs = { uiScale: 1, fontScale: 1, pages: [] }; // pages: assigned page ids ([] = all)
let onChange = () => {};
let putTimer = null;

const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)) * 1000) / 1000;

export function getPrefs() { return prefs; }

// --- identity + local cache --------------------------------------------------

function ensureId() {
  deviceId = localStorage.getItem(LS_ID) || "";
  if (!deviceId) {
    deviceId = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now().toString(36));
    localStorage.setItem(LS_ID, deviceId);
  }
  deviceName = localStorage.getItem(LS_NAME) || `Display ${deviceId.slice(0, 4)}`;
}

function loadCachedPrefs() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_PREFS) || "{}");
    prefs = {
      uiScale: clamp(Number(c.uiScale) || 1, UI_MIN, UI_MAX),
      fontScale: clamp(Number(c.fontScale) || 1, FONT_MIN, FONT_MAX),
      pages: Array.isArray(c.pages) ? c.pages : [],
    };
  } catch { /* keep defaults */ }
}

function cachePrefs() { localStorage.setItem(LS_PREFS, JSON.stringify(prefs)); }

// --- apply + persist ---------------------------------------------------------

function apply() { onChange(prefs); }

// Adopt authoritative prefs (from the server or an SSE push) without echoing a
// write back to the server.
function adopt(next) {
  prefs = {
    uiScale: clamp(Number(next.uiScale ?? prefs.uiScale), UI_MIN, UI_MAX),
    fontScale: clamp(Number(next.fontScale ?? prefs.fontScale), FONT_MIN, FONT_MAX),
    pages: Array.isArray(next.pages) ? next.pages : prefs.pages,
  };
  cachePrefs();
  apply();
  syncHud();
}

// A local edit (HUD / keyboard): apply now, cache now, PUT to the server soon.
function edit(next) {
  if (next.uiScale != null) prefs.uiScale = clamp(next.uiScale, UI_MIN, UI_MAX);
  if (next.fontScale != null) prefs.fontScale = clamp(next.fontScale, FONT_MIN, FONT_MAX);
  cachePrefs();
  apply();
  syncHud();
  flashHud();
  queuePut();
}

function queuePut() {
  clearTimeout(putTimer);
  putTimer = setTimeout(() => {
    fetch(`/api/devices/${encodeURIComponent(deviceId)}/prefs`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uiScale: prefs.uiScale, fontScale: prefs.fontScale, name: deviceName }),
    }).catch(() => { /* offline — local cache still applied */ });
  }, 400);
}

function viewport() { return `${window.innerWidth}×${window.innerHeight}`; }

async function heartbeat() {
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: deviceName, viewport: viewport() }),
    });
    if (res.ok) adopt(await res.json());  // server is source of truth once reachable
  } catch { /* offline — cached prefs already applied */ }
}

// Called by app.js from the SSE `device-prefs` listener.
export function onDevicePrefs(data) {
  if (!data || data.id !== deviceId) return;   // another display — ignore
  if (data.name != null) { deviceName = data.name; localStorage.setItem(LS_NAME, deviceName); }
  adopt(data);
}

// --- on-screen HUD -----------------------------------------------------------

let hud = null, hudEls = {}, flashTimer = null;

function buildHud() {
  const gear = document.createElement("button");
  gear.id = "scale-gear";
  gear.title = "Display size (Alt+S)";
  gear.textContent = "⚙";
  gear.onclick = toggleHud;
  document.body.appendChild(gear);

  hud = document.createElement("div");
  hud.className = "scale-hud";
  hud.hidden = true;
  hud.innerHTML = `
    <h3>Display size</h3>
    <p class="hud-sub">This screen only · saved per device</p>
    <input class="hud-name" type="text" maxlength="40" placeholder="Name this display" />
    <div class="hud-row">
      <label>Overall size</label>
      <div class="hud-stepper">
        <button data-act="ui-">−</button>
        <span class="hud-val" data-val="ui">100%</span>
        <button data-act="ui+">+</button>
      </div>
    </div>
    <div class="hud-row">
      <label>Text</label>
      <div class="hud-stepper">
        <button data-act="font-">−</button>
        <span class="hud-val" data-val="font">100%</span>
        <button data-act="font+">+</button>
      </div>
    </div>
    <div class="hud-foot">
      <button data-act="reset">Reset</button>
      <button class="primary" data-act="close">Done</button>
    </div>
    <div class="hud-keys">Alt +/− size · Alt+Shift +/− text · Alt+0 reset</div>`;
  document.body.appendChild(hud);

  hudEls.name = hud.querySelector(".hud-name");
  hudEls.ui = hud.querySelector('[data-val="ui"]');
  hudEls.font = hud.querySelector('[data-val="font"]');

  hudEls.name.value = deviceName;
  hudEls.name.onchange = () => {
    deviceName = hudEls.name.value.trim() || `Display ${deviceId.slice(0, 4)}`;
    hudEls.name.value = deviceName;
    localStorage.setItem(LS_NAME, deviceName);
    queuePut();
  };

  hud.onclick = (e) => {
    const act = e.target.getAttribute?.("data-act");
    if (!act) return;
    if (act === "ui+") edit({ uiScale: prefs.uiScale + UI_STEP });
    else if (act === "ui-") edit({ uiScale: prefs.uiScale - UI_STEP });
    else if (act === "font+") edit({ fontScale: prefs.fontScale + FONT_STEP });
    else if (act === "font-") edit({ fontScale: prefs.fontScale - FONT_STEP });
    else if (act === "reset") edit({ uiScale: 1, fontScale: 1 });
    else if (act === "close") setHud(false);
  };
}

function syncHud() {
  if (!hudEls.ui) return;
  hudEls.ui.textContent = Math.round(prefs.uiScale * 100) + "%";
  hudEls.font.textContent = Math.round(prefs.fontScale * 100) + "%";
}

function setHud(open) {
  if (!hud) return;
  hud.hidden = !open;
  document.body.classList.toggle("hud-open", open);
  if (open) syncHud();
}
function toggleHud() { setHud(hud?.hidden); }

// Pop the HUD open briefly when scaling via the keyboard, so the value is visible.
function flashHud() {
  if (!hud) return;
  setHud(true);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setHud(false), 1400);
}

// --- keyboard (Alt-based, to avoid clashing with browser Ctrl +/- zoom) ------

function onKey(e) {
  if (!e.altKey) return;
  const k = e.key;
  if (k === "s" || k === "S") { e.preventDefault(); clearTimeout(flashTimer); toggleHud(); return; }
  if (k === "0") { e.preventDefault(); edit({ uiScale: 1, fontScale: 1 }); return; }
  const plus = k === "+" || k === "=" || k === "ArrowUp";
  const minus = k === "-" || k === "_" || k === "ArrowDown";
  if (!plus && !minus) return;
  e.preventDefault();
  const step = (plus ? 1 : -1);
  if (e.shiftKey) edit({ fontScale: prefs.fontScale + step * FONT_STEP });
  else edit({ uiScale: prefs.uiScale + step * UI_STEP });
}

// --- init --------------------------------------------------------------------

export function initDevices(opts = {}) {
  onChange = opts.onChange || (() => {});
  ensureId();
  loadCachedPrefs();
  apply();                       // instant: cached prefs before any network
  buildHud();
  syncHud();
  window.addEventListener("keydown", onKey);
  let rzTimer = null;
  window.addEventListener("resize", () => { clearTimeout(rzTimer); rzTimer = setTimeout(heartbeat, 600); });
  heartbeat();                   // register + pull authoritative prefs
  return { getPrefs, onDevicePrefs };
}
