// Tiny DOM helpers shared by widget plugins (no framework, no build).
import { get as getPlugin } from "./registry.js";

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// Scene-driven variant label (set by app.js while a scene is active). Widgets
// that define a matching variant.label use it; others fall back to prior rules.
let sceneVariantLabel = null;

export function setSceneVariantLabel(label) {
  sceneVariantLabel = label && String(label).trim() ? String(label).trim() : null;
}

export function getSceneVariantLabel() {
  return sceneVariantLabel;
}

// Apply variant overrides over a widget's settings (shallow merge), so heavy
// embeds don't repeat full URLs N times in config. Scene label wins when it
// matches a variant; otherwise the first variant is the default (if any).
export function effectiveSettings(widget) {
  const base = { ...(widget.settings || {}) };
  const variants = widget.variants || [];
  let active = null;
  if (sceneVariantLabel) {
    active = variants.find((v) => v.label === sceneVariantLabel) || null;
  }
  if (!active) active = variants[0] || null;
  return active ? { ...base, ...(active.overrides || {}) } : base;
}

export function fmtNum(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

// Fetch a data provider's JSON: /api/data/<provider>?<params>
export async function fetchData(provider, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/data/${provider}${qs ? "?" + qs : ""}`);
  if (!res.ok) throw new Error(`${provider}: ${res.status}`);
  return res.json();
}

// ---- shared states: setup, error, out of date ---------------------------------
//
// One design for every widget. Blue "setup" says what to add and where; red
// "error" says the widget couldn't get data and has nothing to show; amber
// "stale" keeps the last good data on screen and marks how old it is.

const ICON_PATHS = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l9-9M17 5l2 2M15 7l2 2"/>',
  offline: '<path d="M3 9a14 14 0 0 1 18 0M6.5 12.5a9 9 0 0 1 11 0M10 16a4 4 0 0 1 4 0"/><path d="M4 4l16 16"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  printer: '<path d="M6 9V3h12v6M6 18H4v-7h16v7h-2M6 14h12v7H6z"/>',
};

/**
 * @param tone   "setup" (blue) or "error" (red)
 * @param icon   a key of ICON_PATHS
 * @param where  optional breadcrumb, e.g. "Admin › Settings › API keys"
 */
export function stateView({ tone = "setup", icon = "list", title, body, where }) {
  const ico = el("div", {
    class: "state-ico",
    html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[icon] || ICON_PATHS.list}</svg>`,
  });
  return el("div", { class: `widget-state ${tone}`, role: "status" }, [
    ico,
    el("div", { class: "state-title" }, title),
    body ? el("div", { class: "state-body" }, body) : null,
    where ? el("div", { class: "state-where" }, where) : null,
  ]);
}

/** "just now", "5 min ago", "2 h ago", "3 days ago" */
export function ago(ms, now = Date.now()) {
  // Floor, not round: 30 seconds old is "just now", not "1 min ago".
  const m = Math.max(0, Math.floor((now - ms) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * Run a data widget's load with the shared failure rules.
 *
 *   - success: render, remember when, clear any out-of-date mark
 *   - failure with earlier data: keep it, dim it, badge "Updated 2 h ago"
 *   - failure with nothing yet: the red error state
 *
 * A refresh that fails used to replace a perfectly good forecast with
 * "weather unavailable"; one network blip blanked the tile.
 *
 * @param handle  the widget handle; needs `.body` (the widget's root element)
 * @param load    async () => data
 * @param render  (data) => void, draws into handle.body
 * @param error   { title, body? } for the nothing-to-show case
 */
export async function loadInto(handle, opts) {
  const { load, render, error } = opts;
  let data;
  try {
    data = await load();
  } catch {
    markFailed(handle, error.title, error.body, () => loadInto(handle, opts));
    return null;
  }
  render(data);
  markOk(handle);
  return data;
}

/** After a successful render: remember when, clear any out-of-date mark. */
export function markOk(handle) {
  clearTimeout(handle.retryTimer);
  handle.retryTimer = null;
  handle.retryStep = 0;
  pendingRetries.delete(handle);
  handle.body.classList.remove("is-stale");
  handle.body.querySelector(":scope > .stale-badge")?.remove();
  handle.lastOk = Date.now();
}

// A widget with nothing to show retries quickly, backing off to its normal
// interval — a Pi that boots before its Wi-Fi is up shouldn't leave the wall
// red for 15 minutes. Coming back online retries everything at once.
const BACKOFF = [15, 30, 60, 120, 300];
const pendingRetries = new Map(); // handle -> retry fn
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    for (const [handle, retry] of [...pendingRetries]) {
      clearTimeout(handle.retryTimer);
      retry();
    }
  });
}

/**
 * After a failed load: keep earlier data and mark its age, or show the red
 * error state when there's nothing to keep. For widgets whose refresh has its
 * own try/catch, this is the whole catch block.
 *
 * @param retry  () => void: reloads this widget. With nothing on screen yet it
 *               runs on a short backoff instead of waiting a whole interval.
 */
export function markFailed(handle, title, body, retry) {
  if (handle.lastOk) {
    handle.body.classList.add("is-stale");
    let badge = handle.body.querySelector(":scope > .stale-badge");
    if (!badge) {
      badge = el("span", { class: "stale-badge" });
      handle.body.prepend(badge);
    }
    badge.textContent = `Updated ${ago(handle.lastOk)}`;
    return;
  }
  const usual = handle.widget?.refreshSeconds ?? getPlugin(handle.widget?.type)?.meta?.defaultRefreshSeconds;
  let next = usual;
  if (retry) {
    const step = handle.retryStep || 0;
    next = Math.min(BACKOFF[Math.min(step, BACKOFF.length - 1)], usual || Infinity);
    handle.retryStep = step + 1;
    clearTimeout(handle.retryTimer);
    handle.retryTimer = setTimeout(() => { pendingRetries.delete(handle); retry(); }, next * 1000);
    pendingRetries.set(handle, retry);
  }
  const when = next
    ? `Trying again in ${next < 60 ? `${next} seconds` : next < 120 ? "1 minute" : `${Math.round(next / 60)} minutes`}.`
    : "It will try again when the page reloads.";
  handle.body.replaceChildren(stateView({
    tone: "error", icon: "offline", title,
    // Two parts so a short card can drop the advice and keep the retry time.
    body: body || [
      el("span", { class: "state-retry" }, when),
      " ",
      el("span", { class: "state-advice" }, "Check the Pi's internet connection if it keeps happening."),
    ],
  }));
}
