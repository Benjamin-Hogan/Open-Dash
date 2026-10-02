// Dashboard runtime: render pages into a keep-alive cache, rotate through them in
// slideshow mode (soft-suspend media so video resumes), and live-reload over SSE.
import * as registry from "./widgets/index.js";
import { el, fetchData, setSceneVariantLabel } from "./widgets/dom.js";
import { initDevices, getPrefs, onDevicePrefs } from "./device.js";
import {
  inWindow,
  resolveActiveScene,
  settingsWithScene,
  rotationWithScene,
} from "./scenes.js";

const grid = document.getElementById("grid");
const dots = document.getElementById("pagedots");
const pinnedHost = document.getElementById("pinned-host");
let active = []; // current page: [{ widget, card, plugin, handle, refreshTimer, scheduleTimer }]
// Keep mounted pages across rotation so video/YouTube don't remount from t=0.
// Soft-suspend pauses media; hard release (slideshow/schedule) still blanks src.
const pageCache = new Map(); // pageId -> { pageId, entries, pane }
let activePageId = null;
let renderGen = 0;

// page/rotation state
let config = null;
let order = [];          // ordered list of ALL Page objects
let visible = [];        // pages this display currently shows (device prefs + schedule + conditions)
let pageIndex = 0;       // index into `visible`
let rotationTimer = null;
let paused = false;      // user tapped a dot → stop auto-advance
let appliedSceneId = null; // last resolved scene id (for schedule edge detection)
let effectiveRotation = {}; // rotation after scene overlay

// Live page conditions (print / weather alert / YouTube live / calendar soon).
// Results are cached asynchronously; computeVisible() reads the cache sync.
const DEFAULT_CONDITION_POLL_SECONDS = 5;
const SEVERITY_RANK = { info: 0, warning: 1, danger: 2 };
let conditionCache = new Map(); // pageId -> boolean
let conditionPollTimer = null;
let conditionEvalGen = 0;
// Min-hold after a force-override jump: stay at least until `until`, even if
// the condition clears early; then resume normal rotation.
let overrideHold = null; // { pageId, until }

// Page transition catalog (Settings.pageTransition: off | random | id)
const TRANSITION_CATALOG = [
  "fade", "slide-left", "slide-right", "slide-up", "slide-down",
  "zoom-in", "zoom-out", "wipe-left", "wipe-right", "blur-fade", "scale-rotate",
];
let lastTransition = null;
const TRANSITION_MS = 420;

// Pinned widget (heads-up strip) — mounted once, survives page rotation.
let pinnedEntry = null; // { widget, plugin, handle, refreshTimer, host }

// Preview mode (admin's live mini-preview iframe): ?page=<id> locks to one page,
// no rotation, no device identity (so previews don't register as displays).
const urlParams = new URLSearchParams(location.search);
const previewPageId = urlParams.get("page");
const isPreview = previewPageId != null || urlParams.get("preview") === "1";
if (isPreview) document.body.classList.add("preview");

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

function resolveTransitionStyle() {
  const mode = config?.settings?.pageTransition ?? "random";
  if (prefersReducedMotion() || mode === "off") return null;
  if (mode === "random") {
    const pool = TRANSITION_CATALOG.filter((t) => t !== lastTransition);
    const pick = pool[Math.floor(Math.random() * pool.length)] || TRANSITION_CATALOG[0];
    lastTransition = pick;
    return pick;
  }
  return TRANSITION_CATALOG.includes(mode) ? mode : "fade";
}

function findPinnedWidget(cfg) {
  for (const page of cfg?.pages || []) {
    for (const w of page.widgets || []) {
      if (w.pinned && w.enabled !== false) return w;
    }
  }
  return null;
}

function applyPinnedInset(widget) {
  if (!pinnedHost || pinnedHost.classList.contains("hidden")) {
    document.documentElement.style.removeProperty("--pinned-inset");
    document.body.classList.remove("pinned-top", "pinned-bottom");
    return;
  }
  const pos = widget?.settings?.position === "top" ? "top" : "bottom";
  document.body.classList.toggle("pinned-top", pos === "top");
  document.body.classList.toggle("pinned-bottom", pos === "bottom");
  document.documentElement.style.setProperty("--pinned-inset", "52px");
}

function destroyPinned() {
  if (!pinnedEntry) return;
  clearInterval(pinnedEntry.refreshTimer);
  pinnedEntry.plugin?.destroy?.(pinnedEntry.handle);
  pinnedEntry.host?.remove();
  pinnedEntry = null;
  if (pinnedHost) {
    pinnedHost.replaceChildren();
    pinnedHost.classList.add("hidden");
  }
  applyPinnedInset(null);
}

async function mountPinned(widget) {
  destroyPinned();
  if (!widget || !pinnedHost) return;
  const plugin = registry.get(widget.type);
  if (!plugin) return;
  pinnedHost.classList.remove("hidden");
  applyPinnedInset(widget);
  const card = el("div", { class: "pinned-card card", "data-id": widget.id });
  const body = el("div", { class: "card-body pinned-body" });
  card.appendChild(body);
  pinnedHost.appendChild(card);
  const entry = { widget, plugin, handle: null, refreshTimer: null, host: card };
  try {
    entry.handle = await plugin.mount(body, widget, {});
  } catch (err) {
    body.appendChild(el("div", { class: "widget-error" }, `Failed: ${err.message}`));
  }
  const refreshSecs = widget.refreshSeconds ?? widget.settings?.refreshSeconds ?? plugin.meta?.defaultRefreshSeconds ?? 60;
  if (entry.handle && plugin.refresh && refreshSecs >= 1) {
    entry.refreshTimer = setInterval(
      () => plugin.refresh(entry.handle, widget),
      refreshSecs * 1000,
    );
  }
  pinnedEntry = entry;
}

function waitTransition(node, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      node.removeEventListener("animationend", onEnd);
      clearTimeout(fallback);
      resolve();
    };
    const onEnd = (e) => {
      if (e.target === node) finish();
    };
    node.addEventListener("animationend", onEnd);
    const fallback = setTimeout(finish, ms + 80);
  });
}

async function runPageTransition(outPane, inPane, style, gen) {
  inPane.classList.add("active", "pane-enter", `pane-enter--${style}`);
  inPane.style.zIndex = "2";
  outPane.classList.add("pane-exit", `pane-exit--${style}`);
  outPane.style.zIndex = "1";
  await waitTransition(outPane, TRANSITION_MS);
  if (gen !== renderGen) return false;
  outPane.classList.remove("active", "pane-exit", `pane-exit--${style}`);
  outPane.style.zIndex = "";
  outPane.inert = true;
  outPane.setAttribute("aria-hidden", "true");
  inPane.classList.remove("pane-enter", `pane-enter--${style}`);
  inPane.style.zIndex = "";
  return true;
}

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

function resolveThemeMode(mode) {
  if (mode === "light" || mode === "dark") return mode;
  // "auto" (and unknown) → follow the OS preference
  return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
}

function applySettings(settings) {
  document.title = settings.title || "Pi Dashboard";
  const root = document.documentElement;
  root.style.setProperty("--columns", settings.columns || 12);
  root.style.setProperty("--accent", settings.theme?.accent || "#4aa3ff");
  root.dataset.theme = resolveThemeMode(settings.theme?.mode || "dark");
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

function destroyCachedPage(cached) {
  for (const a of cached.entries) {
    clearInterval(a.refreshTimer);
    clearInterval(a.scheduleTimer);
    // Hard release then destroy — config reload / page left the visible set.
    a.plugin?.suspend?.(a.handle);
    a.plugin?.destroy?.(a.handle);
  }
  cached.pane.remove();
}

function teardown() {
  destroyPinned();
  for (const cached of pageCache.values()) destroyCachedPage(cached);
  pageCache.clear();
  active = [];
  activePageId = null;
  grid.replaceChildren();
}

function prunePageCache() {
  const keep = new Set(visible.map((p) => p.id));
  for (const [id, cached] of [...pageCache]) {
    if (keep.has(id)) continue;
    destroyCachedPage(cached);
    pageCache.delete(id);
    if (activePageId === id) {
      activePageId = null;
      active = [];
    }
  }
}

function suspendCachedPage(cached) {
  cached.pane.classList.remove("active");
  cached.pane.inert = true;
  cached.pane.setAttribute("aria-hidden", "true");
  for (const a of cached.entries) {
    // Soft suspend: pause without tearing down media buffers.
    a.plugin?.suspend?.(a.handle, { releaseMedia: false });
  }
}

function resumeCachedPage(cached) {
  cached.pane.inert = false;
  cached.pane.removeAttribute("aria-hidden");
  for (const a of cached.entries) {
    if (a.widget.schedule?.enabled) applySchedule(a);
    else a.plugin?.resume?.(a.handle, { releaseMedia: false });
  }
}

// ---- layout: fit to screen + portrait stacking -------------------------------
//
// Rows used to be a fixed rowHeightPx, so a page only filled as many rows as it
// had — five widgets on a 720p screen used the top 28% and left the rest black.
// With fitToScreen (the default) each page's rows share the screen height, so
// every page fills its display whatever the resolution.
//
// Portrait screens get a one-column stack in reading order (top-to-bottom,
// then left-to-right). Both positions are written as custom properties and the
// stylesheet picks one by orientation, so rotating a tablet needs no re-mount.

function gridOf(w) {
  const g = w.grid || {};
  return { x: g.x ?? 0, y: g.y ?? 0, w: g.w ?? 3, h: g.h ?? 3 };
}

function layoutPane(pane, widgets) {
  const s = config?.settings || {};
  const rows = Math.max(1, ...widgets.map((w) => gridOf(w).y + gridOf(w).h));
  const stackRows = Math.max(1, widgets.reduce((n, w) => n + gridOf(w).h, 0));
  pane.style.setProperty("--page-rows", rows);
  pane.style.setProperty("--stack-rows", stackRows);
  pane.classList.toggle("fit", s.fitToScreen !== false);
  pane.classList.toggle("stackable", (s.portraitLayout || "stack") === "stack");
}

function placeCard(card, widget, widgets) {
  const g = gridOf(widget);
  card.style.setProperty("--col", `${g.x + 1} / span ${g.w}`);
  card.style.setProperty("--row", `${g.y + 1} / span ${g.h}`);
  // Stack position: reading order, each card keeping its own height in rows.
  const ordered = [...widgets].sort((a, b) => gridOf(a).y - gridOf(b).y || gridOf(a).x - gridOf(b).x);
  let start = 1;
  for (const w of ordered) {
    if (w === widget) break;
    start += gridOf(w).h;
  }
  card.style.setProperty("--stack-row", `${start} / span ${g.h}`);
}

async function mountPage(page) {
  const pane = el("div", { class: "page-pane", "data-page": page.id });
  pane.inert = true;
  pane.setAttribute("aria-hidden", "true");
  grid.appendChild(pane);
  const entries = [];
  let cardIndex = 0;
  const shown = (page.widgets || []).filter((w) => w.enabled !== false && !w.pinned);
  layoutPane(pane, shown);
  for (const widget of shown) {
    const plugin = registry.get(widget.type);
    const card = el("div", { class: "card card-enter", "data-id": widget.id });
    card.style.animationDelay = `${Math.min(cardIndex++ * 45, 450)}ms`;
    card.addEventListener("animationend", () => card.classList.remove("card-enter"), { once: true });
    placeCard(card, widget, shown);
    // Titles are opt-out per widget, and off by default for types whose face
    // says what they are (a clock, the weather).
    const showTitle = widget.showTitle ?? plugin?.meta?.showTitle ?? true;
    if (widget.title && showTitle) card.appendChild(el("div", { class: "card-title" }, widget.title));
    const body = el("div", { class: "card-body" });
    card.appendChild(body);
    pane.appendChild(card);

    const entry = { widget, card, plugin, handle: null };
    entries.push(entry);

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
    // Blank means "this widget's usual interval", not "never": a data widget
    // that never refreshes shows a morning forecast all day, and one that
    // failed its first load would stay broken on a screen nobody reloads.
    const every = widget.refreshSeconds ?? plugin.meta?.defaultRefreshSeconds;
    if (every && plugin.refresh) {
      entry.refreshTimer = setInterval(() => plugin.refresh(entry.handle, widget), every * 1000);
    }
    if (widget.schedule?.enabled) {
      applySchedule(entry);
      entry.scheduleTimer = setInterval(() => applySchedule(entry), 30000);
    }
  }
  return { pageId: page.id, entries, pane };
}

// ---- page visibility: device + scene + schedule + live conditions -----------

function conditionEnabled(page) {
  return !!(page?.condition?.enabled && page.condition.type);
}

function findWidgetById(id) {
  if (!id || !config?.pages) return null;
  for (const page of config.pages) {
    for (const w of page.widgets || []) {
      if (w.id === id) return w;
    }
  }
  return null;
}

function sceneAndDeviceFilteredPages() {
  let v = order;
  const scene = resolveActiveScene(config);

  // Scene page set (empty pageIds = all pages)
  if (scene?.pageIds?.length) {
    v = v.filter((p) => scene.pageIds.includes(p.id));
  }

  // Device page assignment (empty = all pages). When a scene restricts pages and
  // the device filter has no overlap, stay empty rather than falling back to all
  // (so a kitchen display can exclude the print-watch page).
  const assigned = getPrefs().pages || [];
  if (assigned.length) {
    const keep = v.filter((p) => assigned.includes(p.id));
    if (keep.length) v = keep;
    else if (scene?.pageIds?.length) v = [];
    // else: keep v (today's fallback when no scene page filter)
  }
  return v;
}

function pickForceOverride(candidates) {
  let best = null;
  for (const p of candidates) {
    if (!conditionEnabled(p)) continue;
    if (p.condition.mode !== "force-override") continue;
    if (!conditionCache.get(p.id)) continue;
    if (
      !best
      || (p.condition.priority ?? 50) > (best.condition.priority ?? 50)
      || (
        (p.condition.priority ?? 50) === (best.condition.priority ?? 50)
        && order.indexOf(p) < order.indexOf(best)
      )
    ) {
      best = p;
    }
  }
  return best;
}

function pageDurationSeconds(page) {
  return page?.durationSeconds
    || effectiveRotation?.defaultDurationSeconds
    || config?.rotation?.defaultDurationSeconds
    || 30;
}

function computeVisible() {
  if (previewPageId) {
    const v = order.filter((p) => p.id === previewPageId);
    return v.length ? v : order.slice(0, 1);
  }

  const devicePages = sceneAndDeviceFilteredPages();
  // Empty after scene∩device means intentionally blank — don't revive via schedules.
  if (!devicePages.length && resolveActiveScene(config)?.pageIds?.length) {
    return [];
  }

  const scheduled = devicePages.filter((p) => inWindow(p.schedule));
  const timeEligible = scheduled.length ? scheduled : devicePages; // never blank on schedule alone

  // Preserve page order; conditioned pages join only while their cache says true.
  let eligible = timeEligible.filter(
    (p) => !conditionEnabled(p) || conditionCache.get(p.id) === true
  );
  // Prefer unconditioned pages when every condition is false; last resort: time set.
  if (!eligible.length) {
    const unconditioned = timeEligible.filter((p) => !conditionEnabled(p));
    eligible = unconditioned.length ? unconditioned : timeEligible;
  }

  const force = pickForceOverride(eligible);
  if (force) {
    if (!overrideHold || overrideHold.pageId !== force.id) {
      overrideHold = {
        pageId: force.id,
        until: Date.now() + pageDurationSeconds(force) * 1000,
      };
    }
    return [force];
  }

  // Condition cleared early: honor minimum hold before resuming rotation.
  if (overrideHold && Date.now() < overrideHold.until) {
    const held = timeEligible.find((p) => p.id === overrideHold.pageId)
      || devicePages.find((p) => p.id === overrideHold.pageId);
    if (held) return [held];
  }
  overrideHold = null;
  return eligible;
}

// Re-evaluate visibility (device prefs, scene/schedule window, or condition cache).
// Re-renders when the visible set or active scene changed — force-override jumps
// switch to the winning page immediately.
function refreshVisibility() {
  if (!config) return;
  const scene = resolveActiveScene(config);
  const nextSceneId = scene?.id || null;
  if (nextSceneId !== appliedSceneId) {
    void show(config);
    return;
  }
  const cur = visible.map((p) => p.id).join("|");
  const next = computeVisible();
  const nextKey = next.map((p) => p.id).join("|");
  const forceJump = !!(
    next.length === 1
    && conditionEnabled(next[0])
    && next[0].condition.mode === "force-override"
    && conditionCache.get(next[0].id)
    && visible[pageIndex]?.id !== next[0].id
  );
  if (nextKey === cur && !forceJump) return;
  const activeId = visible[pageIndex]?.id;
  visible = next;
  if (forceJump) {
    pageIndex = 0;
    paused = false; // override beats a manual page-dot pause
  } else {
    const keep = visible.findIndex((p) => p.id === activeId);
    pageIndex = keep >= 0 ? keep : 0;
  }
  buildDots();
  prunePageCache();
  if (visible.length) renderPage(visible[pageIndex]);
  else {
    teardown();
    grid.appendChild(el("div", { class: "widget-error" }, "No pages for this display / scene"));
  }
  scheduleRotation();
}

async function evaluatePageCondition(page) {
  const c = page.condition;
  if (!c?.enabled) return true;
  try {
    switch (c.type) {
      case "octoprint": {
        const w = findWidgetById(c.sourceWidgetId);
        if (!w || w.type !== "octoprint") return false;
        const params = {};
        if (w.settings?.url) params.url = w.settings.url;
        if (w.id) params.widgetId = w.id;
        const d = await fetchData("octoprint", params);
        if (!d?.configured) return false;
        const states = (c.matchStates?.length ? c.matchStates : ["printing"]);
        return states.some((s) => !!d[s]);
      }
      case "weather-alert": {
        const res = await fetch("/api/alerts");
        if (!res.ok) return false;
        const data = await res.json();
        const min = c.minSeverity || "info";
        const minRank = SEVERITY_RANK[min] ?? 0;
        return (data.alerts || []).some((a) => {
          if (a.source && a.source !== "nws") return false;
          return (SEVERITY_RANK[a.severity] ?? 0) >= minRank;
        });
      }
      case "youtube-live": {
        const w = findWidgetById(c.sourceWidgetId);
        if (!w || w.type !== "youtube-live") return false;
        const channelId = w.settings?.channelId;
        if (!channelId) return false;
        const d = await fetchData("youtube-live", { channelId });
        return !!d?.live;
      }
      case "calendar-soon": {
        const w = findWidgetById(c.sourceWidgetId);
        if (!w || w.type !== "ical") return false;
        const url = w.settings?.url;
        if (!url) return false;
        const d = await fetchData("ical", { url, count: w.settings?.count || 10 });
        const leadMs = Math.max(1, c.leadMinutes || 30) * 60 * 1000;
        const now = Date.now();
        return (d.events || []).some((ev) => {
          const start = Date.parse(ev.start);
          if (Number.isNaN(start)) return false;
          return start >= now && start <= now + leadMs;
        });
      }
      default:
        return false;
    }
  } catch (err) {
    console.warn("page condition failed", page.id, err);
    return false;
  }
}

async function evaluateConditions() {
  if (!config || isPreview) return;
  const gen = ++conditionEvalGen;
  const pages = order.filter(conditionEnabled);
  if (!pages.length) {
    if (conditionCache.size) {
      conditionCache = new Map();
      refreshVisibility();
    }
    return;
  }
  const entries = await Promise.all(
    pages.map(async (p) => [p.id, await evaluatePageCondition(p)])
  );
  if (gen !== conditionEvalGen) return; // stale; a newer eval is in flight
  let changed = false;
  const next = new Map(conditionCache);
  for (const [id, met] of entries) {
    if (next.get(id) !== met) changed = true;
    next.set(id, met);
  }
  // Drop cache entries for pages that no longer have conditions.
  for (const id of [...next.keys()]) {
    if (!pages.some((p) => p.id === id)) {
      next.delete(id);
      changed = true;
    }
  }
  conditionCache = next;
  if (changed) refreshVisibility();
  else if (overrideHold) refreshVisibility(); // may clear expired min-hold
}

function conditionPollSeconds() {
  let min = null;
  for (const p of order) {
    if (!conditionEnabled(p)) continue;
    const n = p.condition.pollSeconds;
    if (n != null && n >= 2) min = min == null ? n : Math.min(min, n);
  }
  return min ?? DEFAULT_CONDITION_POLL_SECONDS;
}

function scheduleConditionPolling() {
  clearInterval(conditionPollTimer);
  conditionPollTimer = null;
  if (isPreview) return;
  const has = order.some(conditionEnabled);
  if (!has) return;
  evaluateConditions();
  conditionPollTimer = setInterval(evaluateConditions, conditionPollSeconds() * 1000);
}

// ---- whole-config entry point (initial load + every SSE config-changed) -----
async function show(cfg) {
  config = cfg;
  const scene = resolveActiveScene(cfg);
  appliedSceneId = scene?.id || null;
  setSceneVariantLabel(scene?.variantLabel || null);

  applySettings(settingsWithScene(cfg.settings || {}, scene));
  effectiveRotation = rotationWithScene(cfg.rotation || {}, scene);

  const pages = cfg.pages || [];
  // resolve page order (explicit ids first, then any leftovers)
  if (effectiveRotation.order?.length) {
    const byId = new Map(pages.map((p) => [p.id, p]));
    order = effectiveRotation.order.map((id) => byId.get(id)).filter(Boolean);
    for (const p of pages) if (!order.includes(p)) order.push(p);
  } else {
    order = [...pages];
  }
  paused = false;
  overrideHold = null;
  // Drop stale condition results for removed pages; keep others until re-eval.
  const keepIds = new Set(order.map((p) => p.id));
  for (const id of [...conditionCache.keys()]) {
    if (!keepIds.has(id)) conditionCache.delete(id);
  }
  visible = computeVisible();
  pageIndex = Math.min(pageIndex, Math.max(0, visible.length - 1));
  buildDots();
  // Config may have changed widget trees — drop cached pages and remount.
  teardown();
  const pinned = findPinnedWidget(cfg);
  if (pinned) await mountPinned(pinned);
  if (visible.length) await renderPage(visible[pageIndex]);
  else {
    grid.appendChild(el("div", { class: "widget-error" },
      order.length ? "No pages for this display / scene" : "No pages configured"));
  }
  scheduleRotation();
  scheduleConditionPolling();
}

let rendering = false; // pause the value-pulse observer during full rebuilds

async function renderPage(page) {
  const gen = ++renderGen;
  // Already showing this cached page — nothing to swap.
  if (activePageId === page.id && pageCache.has(page.id)) {
    prunePageCache();
    return;
  }
  rendering = true;
  try {
    const style = resolveTransitionStyle();
    const outCached = activePageId ? pageCache.get(activePageId) : null;
    const outPane = outCached?.pane || null;

    for (const child of [...grid.children]) {
      if (child.classList?.contains("widget-error")) child.remove();
    }

    let cached = pageCache.get(page.id);
    if (!cached) {
      cached = await mountPage(page);
      if (gen !== renderGen) {
        destroyCachedPage(cached);
        return;
      }
      pageCache.set(page.id, cached);
    }

    const inPane = cached.pane;

    if (outPane && style) {
      resumeCachedPage(cached);
      const ok = await runPageTransition(outPane, inPane, style, gen);
      if (!ok || gen !== renderGen) return;
      for (const a of outCached.entries) {
        a.plugin?.suspend?.(a.handle, { releaseMedia: false });
      }
    } else {
      if (outPane) suspendCachedPage(outCached);
      resumeCachedPage(cached);
      inPane.classList.add("active");
      inPane.inert = false;
      inPane.removeAttribute("aria-hidden");
    }

    active = cached.entries;
    activePageId = page.id;
    prunePageCache();
  } finally {
    if (gen === renderGen) rendering = false;
  }
}

// ---- page rotation (slideshow mode) -----------------------------------------
function scheduleRotation() {
  clearTimeout(rotationTimer);
  const rotation = effectiveRotation || config?.rotation || {};
  // Force-override (and its min-hold) collapses visible to one page — no advance.
  if (isPreview || paused || !rotation.enabled || visible.length < 2) return;
  if (overrideHold) return;
  const page = visible[pageIndex];
  const secs = page.durationSeconds || rotation.defaultDurationSeconds || 30;
  rotationTimer = setTimeout(() => goToPage((pageIndex + 1) % visible.length, false), secs * 1000);
}

function goToPage(i, fromUser) {
  if (rendering) return;
  pageIndex = i;
  if (fromUser) paused = true; // tapping a dot stops auto-advance
  renderPage(visible[pageIndex]);
  updateDots();
  scheduleRotation();
}

function initTouchNav() {
  if (isPreview) return;
  let startX = null;
  let startY = null;
  let startTime = null;
  let longPressTimer = null;

  const clearStart = () => {
    startX = null;
    startY = null;
    startTime = null;
    clearTimeout(longPressTimer);
    longPressTimer = null;
  };

  grid.addEventListener("pointerdown", (e) => {
    if (rendering || e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    startTime = Date.now();
    longPressTimer = setTimeout(() => {
      if (startX == null) return;
      document.getElementById("scale-gear")?.click();
      clearStart();
    }, 800);
  });

  grid.addEventListener("pointermove", (e) => {
    if (startX == null) return;
    if (Math.abs(e.clientX - startX) > 12 || Math.abs(e.clientY - startY) > 12) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  grid.addEventListener("pointerup", (e) => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    if (startX == null || rendering) { clearStart(); return; }
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dt = Date.now() - startTime;
    clearStart();
    if (visible.length < 2) return;
    if (Math.abs(dx) < Math.abs(dy)) return;
    if (Math.abs(dx) < 60 && dt > 350) return;
    if (Math.abs(dx) < 40) return;
    if (dx < 0) goToPage((pageIndex + 1) % visible.length, true);
    else goToPage((pageIndex - 1 + visible.length) % visible.length, true);
  });

  grid.addEventListener("pointercancel", clearStart);
}

function buildDots() {
  if (!dots) return;
  dots.replaceChildren();
  if (visible.length < 2) return;
  visible.forEach((p, i) => {
    const d = el("button", {
      class: "pagedot",
      title: p.name,
      "aria-label": `Show page ${p.name}`,
      onclick: () => goToPage(i, true),
    });
    dots.appendChild(d);
  });
  updateDots();
}

let dotsTimer = null;
/** Mark the current page; the dots show for a few seconds on each change and
 *  then fade, rather than sitting on the screen permanently. */
function updateDots() {
  if (!dots) return;
  [...dots.children].forEach((d, i) => d.classList.toggle("active", i === pageIndex));
  if (!dots.children.length) return;
  dots.classList.add("show");
  clearTimeout(dotsTimer);
  dotsTimer = setTimeout(() => dots.classList.remove("show"), 3000);
}

// Hide the pointer after a few seconds of stillness; any movement brings it back.
let idleTimer = null;
function wakePointer() {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add("idle"), 3000);
}
for (const type of ["pointermove", "pointerdown", "keydown"]) {
  window.addEventListener(type, wakePointer, { passive: true });
}
wakePointer();

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

/**
 * @param arriving  true for a live SSE alert; false for the catch-up list on
 *                  load, which shouldn't chime every time a display reloads.
 */
function showAlert(a, { arriving = false } = {}) {
  if (!alertHost || !a?.id) return;
  const existing = alertHost.querySelector(`[data-alert="${CSS.escape(a.id)}"]`);
  // Settings change re-broadcasts the same id with a new expiresAt — reset timer.
  if (existing) {
    clearTimeout(alertTimers.get(a.id));
    alertTimers.delete(a.id);
  } else {
    const banner = el("div", { class: `alert alert-${a.severity || "info"} alert-flash`, "data-alert": a.id }, [
      el("div", { class: "alert-text" }, [
        el("div", { class: "alert-title" }, a.title || "Alert"),
        a.message ? el("div", { class: "alert-msg" }, a.message) : null,
      ]),
      el("button", { class: "alert-close", title: "Dismiss", onclick: () => dismissAlert(a.id, { notifyServer: true }) }, "✕"),
    ]);
    alertHost.prepend(banner);
    if (arriving) chime(a.severity);
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

/** "HH:MM" → minutes after midnight, or null. */
function toMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Inside the alert quiet hours? The window may wrap past midnight. */
function inQuietHours(alerts, now = new Date()) {
  const start = toMinutes(alerts?.quietStart);
  const end = toMinutes(alerts?.quietEnd);
  if (start == null || end == null || start === end) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return start < end ? t >= start && t < end : t >= start || t < end;
}

let audioCtx = null;
/**
 * A short two-note chime for an arriving alert, when Settings → Alerts has
 * sound on and it isn't quiet hours. Synthesised, so there's no asset to ship.
 * Browsers only allow audio after the page has had a user gesture or when the
 * kiosk is launched with autoplay allowed (Chromium:
 * --autoplay-policy=no-user-gesture-required); otherwise this stays silent.
 */
function chime(severity) {
  const a = config?.settings?.alerts;
  if (!a?.sound || inQuietHours(a)) return;
  try {
    audioCtx ||= new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const notes = severity === "danger" ? [880, 660, 880] : [660, 880];
    const t0 = audioCtx.currentTime;
    notes.forEach((hz, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      const t = t0 + i * 0.18;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  } catch { /* no audio on this device — the flash still shows */ }
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
    try { showAlert(JSON.parse(e.data), { arriving: true }); } catch { /* ignore malformed */ }
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
  initTouchNav();
  // page / scene schedules and override min-hold cross boundaries without other triggers
  setInterval(refreshVisibility, 30000);
})();
