// Live widget rendering inside the layout canvas.
//
// The canvas used to be grey rectangles with a title, so every layout decision
// was a guess you checked afterwards by saving and squinting at a mini preview.
// Here each box mounts the *real* widget through the same call the dashboard
// uses — plugin.mount(el, widget, ctx) — so you lay out what you'll actually
// see. Two facts make that affordable:
//
//   · widget CSS is container-query based (container-type: size, sizing in
//     cqi/cqh), so a widget self-scales to whatever box it's given. No
//     transform tricks, no separate small-size styling.
//   · providers are cached server-side, so N clocks and a weather tile are
//     cheap. The expensive ones are embeds, and those are handled below.
//
// The budget is the whole point. An editor that stutters is worse than one that
// shows grey boxes.

import * as registry from "/widgets/index.js";

// Widget types that own an iframe, a video element or an animated image. One
// of these is fine; six will fight the editor for the main thread and the
// network. They render as a poster until explicitly woken.
const HEAVY = new Set([
  "iframe", "video", "youtube-live", "embed", "space-imagery", "photos", "image",
]);

// Ceiling on simultaneously mounted widgets, live or not. Beyond this the
// least-recently-shown boxes fall back to a poster.
const MAX_MOUNTED = 12;

const mounted = new Map(); // widgetId -> { el, handle, plugin, type, seq }
let seq = 0;
let liveMode = true;
let observer = null;
let wokenHeavy = null;     // the one heavy widget the user asked to run

export const isLive = () => liveMode;

export function setLive(on) {
  liveMode = !!on;
  if (!liveMode) unmountAll();
}

export function isHeavy(type) { return HEAVY.has(type); }

// ---- mounting ---------------------------------------------------------------

function unmount(id) {
  const entry = mounted.get(id);
  if (!entry) return;
  try { entry.plugin?.suspend?.(entry.handle); } catch { /* plugin teardown is best-effort */ }
  mounted.delete(id);
  entry.el.replaceChildren();
}

export function unmountAll() {
  for (const id of [...mounted.keys()]) unmount(id);
}

function evictIfNeeded() {
  while (mounted.size > MAX_MOUNTED) {
    // Least recently mounted wins the eviction.
    let oldest = null;
    for (const [id, e] of mounted) if (!oldest || e.seq < oldest[1].seq) oldest = [id, e];
    if (!oldest) break;
    unmount(oldest[0]);
    renderPoster(oldest[1].el, oldest[1].widget, "Paused to keep the editor responsive");
  }
}

/** A labelled stand-in: what the widget is, and enough to recognise it. */
function renderPoster(host, widget, reason) {
  host.replaceChildren();
  const plugin = registry.get(widget.type);
  const card = document.createElement("div");
  card.className = "live-poster";

  const label = document.createElement("div");
  label.className = "live-poster-type";
  label.textContent = plugin?.meta?.label || widget.type;
  card.appendChild(label);

  const detail = widget.settings?.url || widget.settings?.source || widget.settings?.folder;
  if (detail) {
    const d = document.createElement("div");
    d.className = "live-poster-detail";
    d.textContent = String(detail).replace(/^https?:\/\//, "");
    card.appendChild(d);
  }

  const note = document.createElement("div");
  note.className = "live-poster-note";
  note.textContent = reason;
  card.appendChild(note);

  if (HEAVY.has(widget.type) && liveMode) {
    const go = document.createElement("button");
    go.type = "button";
    go.className = "btn small ghost live-poster-go";
    go.textContent = "▶ Go live";
    go.onclick = (e) => {
      e.stopPropagation();
      wokenHeavy = widget.id;
      mount(host, widget, { force: true });
    };
    card.appendChild(go);
  }

  host.appendChild(card);
}

function renderError(host, widget, err) {
  host.replaceChildren();
  const d = document.createElement("div");
  d.className = "live-error";
  d.textContent = `⚠ ${widget.title || widget.type} failed to render`;
  d.title = String(err?.message || err);
  host.appendChild(d);
}

/**
 * Render one widget into its canvas box body.
 * Errors are contained per box — a throwing plugin must never break the editor.
 */
export async function mount(host, widget, { force = false } = {}) {
  const plugin = registry.get(widget.type);
  if (!plugin?.mount) { renderPoster(host, widget, "No renderer for this type"); return; }

  if (!liveMode) { renderPoster(host, widget, "Static mode"); return; }
  if (widget.enabled === false) { renderPoster(host, widget, "Disabled — hidden on displays"); return; }
  if (HEAVY.has(widget.type) && !force && wokenHeavy !== widget.id) {
    renderPoster(host, widget, "Heavy embed — not run in the editor");
    return;
  }
  if (HEAVY.has(widget.type) && force) {
    // Only one heavy widget runs at a time.
    for (const [id, e] of mounted) {
      if (HEAVY.has(e.type) && id !== widget.id) {
        unmount(id);
        renderPoster(e.el, e.widget, "Heavy embed — not run in the editor");
      }
    }
  }

  unmount(widget.id);
  host.replaceChildren();
  try {
    const handle = await plugin.mount(host, widget, { admin: true });
    mounted.set(widget.id, { el: host, handle, plugin, type: widget.type, widget, seq: ++seq });
    evictIfNeeded();
  } catch (e) {
    renderError(host, widget, e);
  }
}

// ---- viewport gating --------------------------------------------------------

/**
 * Release widgets that scroll out of view and bring them back on return.
 *
 * This is an optimisation, not the mount path. IntersectionObserver only
 * delivers callbacks while the page is actually compositing, so a background
 * tab (or a hidden preview pane) would otherwise leave every box empty
 * forever. First mount is eager — see mountAll.
 */
export function observe(root) {
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const body = entry.target.querySelector(".canvas-box-live");
      if (!body?._widget) continue;
      if (entry.isIntersecting) {
        if (!mounted.has(body._widget.id)) mount(body, body._widget);
      } else if (mounted.has(body._widget.id)) {
        unmount(body._widget.id);
        renderPoster(body, body._widget, "Scrolled out of view");
      }
    }
  }, { root, rootMargin: "200px", threshold: 0.01 });
  return observer;
}

export function track(box) { observer?.observe(box); }

/** Mount every tracked box now, nearest the top first so the budget favours
 *  what the user is most likely looking at. */
export function mountAll(boxes) {
  const ordered = [...boxes].sort((a, b) => a.offsetTop - b.offsetTop || a.offsetLeft - b.offsetLeft);
  for (const box of ordered) {
    const body = box.querySelector(".canvas-box-live");
    if (!body?._widget) continue;
    if (mounted.size >= MAX_MOUNTED && !HEAVY.has(body._widget.type)) {
      renderPoster(body, body._widget, "Paused to keep the editor responsive");
      continue;
    }
    mount(body, body._widget);
  }
}

/** Re-render one widget in place after its settings changed. */
export function refresh(widget) {
  const entry = mounted.get(widget.id);
  if (!entry) return;
  mount(entry.el, widget, { force: HEAVY.has(widget.type) && wokenHeavy === widget.id });
}

export function stats() {
  return { mounted: mounted.size, live: liveMode, wokenHeavy };
}
