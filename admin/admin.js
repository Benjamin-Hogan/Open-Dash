// Schema-driven admin with multi-page layouts, a visual drag/resize editor, and
// slideshow-mode config. Widget position/size are edited on the canvas; the form
// handles type + settings only.
//
// Edits are STAGED: `state.config` is a long-lived mutable working copy, and
// save(label) records it in the store as one undoable step. Nothing reaches the
// server until Save (js/savebar.js), which merges rather than clobbers on 409.
import * as registry from "/widgets/index.js";
import { buildEmbedDoc } from "/widgets/embed.js";
import * as store from "/js/core/store.js";
import * as api from "/js/core/api.js";
import * as savebar from "/js/savebar.js";
import { clone } from "/js/core/clone.js";
import { rotationPages, hasCustomOrder, syncRotationOrder } from "/js/model/order.js";
import * as liveHost from "/js/view/live-host.js";
import { catalog, grouped, search, defaultSettings } from "/js/model/catalog.js";

const state = { config: null, activePage: 0, editingId: null, selection: new Set() };
const $ = (s) => document.querySelector(s);

const EDITOR_ROW = 26; // px per grid row in the visual editor
const CANVAS_GAP = 4;

function pages() { return state.config.pages || (state.config.pages = []); }
function currentPage() { return pages()[state.activePage] || null; }
function currentWidgets() {
  const p = currentPage();
  return p ? (p.widgets || (p.widgets = [])) : [];
}
function rotation() {
  return state.config.rotation || (state.config.rotation = { enabled: false, defaultDurationSeconds: 30, order: [] });
}
function scenes() {
  return state.config.scenes || (state.config.scenes = []);
}

let dashPort = 8082;

async function load() {
  try {
    const [cfg, meta] = await Promise.all([
      api.loadConfig(),
      api.loadMeta().catch(() => null),
    ]);
    if (meta?.dashboardPort) dashPort = meta.dashboardPort;
    refreshMissingKeys(); // fire and forget: only drives a badge in the picker

    store.reset(cfg);
    onConfigReplaced(cfg);

    savebar.init({
      host: document.querySelector(".topbar .actions"),
      onExternalConfig: (next) => onConfigReplaced(next),
      onValidationErrors: (errs) => {
        // Until the form engine anchors these to fields, at least name the path.
        for (const e of errs.slice(0, 3)) toast(`${e.path || "config"}: ${e.message}`, "err");
      },
      toast,
    });

    // A tab that crashed or was closed mid-edit gets its work back.
    savebar.offerDraftRecovery(cfg.version, (draft) => {
      onConfigReplaced(draft);
      save("restored unsaved changes");
      toast("Unsaved changes restored — press Save to apply them", "ok");
    });
  } catch (e) {
    toast("Could not load config: " + e.message, "err");
  }
}

function renderAll() { renderPageBar(); renderCanvas(); renderList(); updatePreview(); }

// ---- live mini-preview (the real dashboard, one page, scaled down) -----------
// The dashboard app supports ?page=<id>: locked to that page, no rotation, no
// device registration. It live-reloads over SSE on every save, so this iframe
// always shows the page as it will actually render. Port comes from /api/meta.
let previewOn = false;

function previewUrl() {
  const p = currentPage();
  return `http://${location.hostname}:${dashPort}/?page=${encodeURIComponent(p ? p.id : "")}`;
}

function updatePreview() {
  const wrap = $("#preview-wrap");
  const frame = $("#preview-frame");
  if (!wrap || !frame) return;
  wrap.classList.toggle("hidden", !previewOn);
  $("#btn-preview")?.classList.toggle("primary", previewOn);
  if (!previewOn) { frame.removeAttribute("src"); return; }
  const url = previewUrl();
  if (frame.getAttribute("src") !== url) frame.setAttribute("src", url);
  // the iframe renders at 1280×720; scale it down to the panel width
  frame.style.transform = `scale(${wrap.clientWidth / 1280})`;
}

function togglePreview() { previewOn = !previewOn; updatePreview(); }
window.addEventListener("resize", () => { if (previewOn) updatePreview(); });

// ---- page bar ---------------------------------------------------------------

function pageIsGated(p) {
  return !!(p?.schedule?.enabled || p?.condition?.enabled);
}

function renderPageBar() {
  const bar = $("#page-bar");
  bar.replaceChildren();
  pages().forEach((p, i) => {
    const tab = document.createElement("button");
    const gated = pageIsGated(p);
    tab.className = "page-tab"
      + (i === state.activePage ? " active" : "")
      + (gated ? " gated" : "");
    const label = document.createElement("span");
    label.textContent = p.name || "Page";
    tab.appendChild(label);
    if (gated) {
      const badge = document.createElement("span");
      badge.className = "page-tab-badge" + (p.condition?.enabled ? " condition" : "");
      badge.title = [
        p.schedule?.enabled ? "Time schedule" : null,
        p.condition?.enabled ? "Live condition" : null,
      ].filter(Boolean).join(" · ");
      tab.appendChild(badge);
    }
    const tips = [];
    if (rotation().enabled && p.durationSeconds) tips.push(`Shows for ${p.durationSeconds}s`);
    if (p.schedule?.enabled) tips.push("Scheduled");
    if (p.condition?.enabled) tips.push("Conditional");
    if (tips.length) tab.title = tips.join(" · ");
    // Clicking the tab you're already on opens that page's settings — the same
    // gesture as clicking a widget to inspect it.
    tab.onclick = () => {
      const wasActive = i === state.activePage;
      state.activePage = i;
      renderAll();
      if (wasActive || state.editingId == null) openPageSettings(i);
    };
    bar.appendChild(tab);
  });
  const add = document.createElement("button");
  add.className = "page-add";
  add.textContent = "＋ Page";
  add.onclick = addPage;
  bar.appendChild(add);

  // Actions for the active page. Rename and Schedule used to live here as a
  // prompt() and a separate panel; both are now in the Page settings inspector.
  const acts = document.createElement("div");
  acts.className = "page-actions";
  const mk = (label, cls, fn, title) => {
    const b = document.createElement("button");
    b.className = "btn small " + (cls || "");
    b.textContent = label;
    if (title) b.title = title;
    b.onclick = fn;
    return b;
  };
  acts.append(
    mk("Settings", pageIsGated(pages()[state.activePage]) ? "scheduled" : "ghost",
       () => openPageSettings(state.activePage), "Name, duration, schedule and conditions"),
    mk("Duplicate", "ghost", () => duplicatePage(state.activePage)),
    mk("←", "ghost icon", () => movePage(state.activePage, -1), "Move page left"),
    mk("→", "ghost icon", () => movePage(state.activePage, 1), "Move page right"),
    mk("Delete", "ghost danger", () => deletePage(state.activePage), "Delete this page"),
  );
  bar.appendChild(acts);
}

function addPage() {
  const id = "page-" + Date.now().toString(36);
  pages().push({ id, name: "New page", widgets: [] });
  state.activePage = pages().length - 1;
  save("added a page");
}
async function renamePage(i) {
  const name = await promptDialog({
    title: "Rename page",
    label: "Page name",
    value: pages()[i].name || "",
  });
  if (name == null) return;
  pages()[i].name = name.trim() || "Page";
  save(`renamed page to “${pages()[i].name}”`);
}
function duplicatePage(i) {
  const src = pages()[i];
  const copy = structuredClone(src);
  copy.id = "page-" + Date.now().toString(36);
  copy.name = (src.name || "Page") + " copy";
  // regenerate widget ids so they stay tidy
  for (const w of copy.widgets || []) w.id = `${w.type}-${Math.random().toString(36).slice(2, 8)}`;
  pages().splice(i + 1, 0, copy);
  state.activePage = i + 1;
  save(`duplicated “${src.name || "page"}”`);
}
function movePage(i, d) {
  const j = i + d;
  if (j < 0 || j >= pages().length) return;
  const ps = pages();
  const moved = ps[i];
  [ps[i], ps[j]] = [ps[j], ps[i]];
  // The page bar is the only page order; rotation follows it.
  syncRotationOrder(state.config);
  state.activePage = j;
  save(`moved “${moved.name || "page"}” ${d < 0 ? "left" : "right"}`);
}
async function deletePage(i) {
  if (pages().length <= 1) { toast("Keep at least one page", "err"); return; }
  const name = pages()[i].name || "page";
  const n = pages()[i].widgets?.length || 0;
  const ok = await savebar.confirmDialog({
    title: "Delete page?",
    message: `“${name}” and its ${n} widget${n === 1 ? "" : "s"} will be removed. You can undo this.`,
    confirmLabel: "Delete page",
    danger: true,
  });
  if (!ok) return;
  pages().splice(i, 1);
  syncRotationOrder(state.config);
  state.activePage = Math.max(0, Math.min(state.activePage, pages().length - 1));
  save(`deleted “${name}”`);
}

// ---- visual layout editor (canvas) ------------------------------------------

function renderCanvas() {
  const canvas = $("#canvas");
  liveHost.unmountAll();
  canvas.replaceChildren();
  const cols = state.config.settings?.columns || 12;
  const widgets = currentWidgets();
  const maxRow = widgets.reduce((m, w) => Math.max(m, (w.grid?.y || 0) + (w.grid?.h || 3)), 0);
  const rows = Math.max(maxRow + 1, 8);
  canvas.style.setProperty("--cols", cols);
  canvas.style.setProperty("--rows", rows);
  canvas.style.setProperty("--editor-row", EDITOR_ROW + "px");
  canvas.style.setProperty("--canvas-gap", CANVAS_GAP + "px");

  // Guides are drawn into an overlay so they can sit above every box without
  // being a child of any of them.
  const guideLayer = document.createElement("div");
  guideLayer.className = "guide-layer";
  guideLayer.id = "guide-layer";
  canvas.appendChild(guideLayer);

  const bad = problems(cols);
  const boxes = [];
  widgets.forEach((w) => {
    if (!w.grid) w.grid = { x: 0, y: 0, w: 4, h: 3 };
    const box = makeBox(w, cols);
    if (bad.has(w.id)) box.classList.add("overlap");
    canvas.appendChild(box);
    boxes.push(box);
  });

  if (!widgets.length) {
    canvas.appendChild(Object.assign(document.createElement("div"), {
      className: "canvas-empty",
      textContent: "No widgets on this page — click “+ Add widget”.",
    }));
  }

  // Mount once the boxes are in the document, so container queries see their
  // real size. Mounting is eager rather than observer-driven: an
  // IntersectionObserver only fires while the page is compositing, so a
  // background tab would sit there with every box empty. The observer below
  // only releases widgets that scroll away.
  liveHost.observe($(".canvas-scroll"));
  for (const box of boxes) liveHost.track(box);
  liveHost.mountAll(boxes);

  updateHint(bad.size);
  updateBulkBar();
}

// flag widgets that overlap each other or run off the grid (x+w > cols)
function problems(cols) {
  const ws = currentWidgets();
  const bad = new Set();
  const g = (w) => w.grid || { x: 0, y: 0, w: 4, h: 3 };
  for (const w of ws) {
    const a = g(w);
    if (a.x < 0 || a.y < 0 || a.x + a.w > cols) bad.add(w.id);
  }
  for (let i = 0; i < ws.length; i++) {
    for (let j = i + 1; j < ws.length; j++) {
      const a = g(ws[i]), b = g(ws[j]);
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
        bad.add(ws[i].id); bad.add(ws[j].id);
      }
    }
  }
  return bad;
}

function updateHint(badCount) {
  const hint = $("#canvas-hint");
  if (!hint) return;
  if (badCount) {
    hint.textContent = `⚠ ${badCount} widget(s) overlap or run off-grid — try “Tidy up”`;
    hint.classList.add("warn");
  } else {
    hint.textContent = "Drag to move · drag corner to resize";
    hint.classList.remove("warn");
  }
}

// pack widgets left-to-right, top-to-bottom with no gaps or overlaps
function tidyUp() {
  const cols = state.config.settings?.columns || 12;
  const ws = currentWidgets();
  const sorted = [...ws].sort((a, b) =>
    ((a.grid?.y || 0) - (b.grid?.y || 0)) || ((a.grid?.x || 0) - (b.grid?.x || 0)));
  let x = 0, y = 0, rowH = 0;
  for (const w of sorted) {
    const grid = w.grid || (w.grid = { x: 0, y: 0, w: 4, h: 3 });
    grid.w = Math.min(grid.w || 4, cols);
    if (x + grid.w > cols) { x = 0; y += rowH; rowH = 0; }
    grid.x = x; grid.y = y;
    x += grid.w; rowH = Math.max(rowH, grid.h || 3);
  }
  renderCanvas();
  save("tidied up the layout");
}

function placeBox(box, w) {
  box.style.gridColumn = `${w.grid.x + 1} / span ${w.grid.w}`;
  box.style.gridRow = `${w.grid.y + 1} / span ${w.grid.h}`;
}

// Eight resize handles, not just the SE corner.
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function makeBox(w, cols) {
  const plugin = registry.get(w.type);
  const box = document.createElement("div");
  box.className = "canvas-box"
    + (w.enabled === false ? " disabled" : "")
    + (isSelected(w.id) ? " selected" : "");
  box.dataset.widgetId = w.id;
  box.tabIndex = 0;
  box.setAttribute("role", "listitem");
  box.setAttribute("aria-label",
    `${w.title || w.type}, column ${w.grid.x + 1} row ${w.grid.y + 1}, ${w.grid.w} by ${w.grid.h}`);
  box.addEventListener("click", (e) => {
    if (e.target.closest(".box-btn, .resize-handle, .live-poster-go")) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) { toggleSelect(w.id); return; }
    selectOnly(w.id);
  });
  placeBox(box, w);

  // Chrome: title, type and tools sit above the live render.
  const label = document.createElement("div");
  label.className = "box-label";
  label.innerHTML = `<span class="box-title"></span><span class="box-type"></span>`;
  label.querySelector(".box-title").textContent = w.title || "(untitled)";
  label.querySelector(".box-type").textContent = (plugin?.meta?.label) || w.type;
  if (w.pinned) {
    const pin = document.createElement("span");
    pin.className = "box-pin";
    pin.textContent = "📌";
    pin.title = "Pinned overlay";
    label.appendChild(pin);
  }
  const variant = activeVariantLabel(w);
  if (variant) {
    const v = document.createElement("span");
    v.className = "box-variant";
    v.textContent = variant;
    v.title = `Variant “${variant}” is what renders right now`;
    label.appendChild(v);
  }
  box.appendChild(label);

  // The live render. Pointer events off so dragging the box never lands inside
  // an embedded iframe or steals a click from the canvas.
  const live = document.createElement("div");
  live.className = "canvas-box-live";
  live._widget = w;
  box.appendChild(live);

  const tools = document.createElement("div");
  tools.className = "box-tools";
  const del = document.createElement("button");
  del.className = "box-btn"; del.textContent = "🗑"; del.title = "Delete";
  del.onclick = (e) => { e.stopPropagation(); delWidget(w.id); };
  tools.append(del);
  box.appendChild(tools);

  for (const dir of HANDLES) {
    const h = document.createElement("div");
    h.className = `resize-handle rh-${dir}`;
    h.dataset.dir = dir;
    h.addEventListener("pointerdown", (e) => { e.stopPropagation(); startDrag(e, w, box, cols, "resize", dir); });
    box.appendChild(h);
  }

  box.addEventListener("pointerdown", (e) => startDrag(e, w, box, cols, "move"));
  return box;
}

// ---- selection --------------------------------------------------------------

function isSelected(id) { return state.editingId === id || state.selection.has(id); }

function selectOnly(id) {
  state.selection.clear();
  if (state.editingId !== id) openEditor(id);
  else { renderCanvas(); renderList(); }
}

function toggleSelect(id) {
  // Shift-clicking builds a multi-selection; the inspector steps aside for the
  // bulk toolbar, since "edit these five widgets" isn't a form.
  if (state.editingId && state.editingId !== id) state.selection.add(state.editingId);
  state.editingId = null;
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  if (state.selection.size === 1) {
    const only = [...state.selection][0];
    state.selection.clear();
    openEditor(only);
    return;
  }
  if (!state.selection.size) { showDefault(); return; }
  renderCanvas(); renderList();
  openBulk();
}

function selectedWidgets() {
  const ids = state.selection.size ? state.selection : new Set(state.editingId ? [state.editingId] : []);
  return currentWidgets().filter((w) => ids.has(w.id));
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Would this rect collide with any widget other than the ones being moved? */
function collides(rect, ignoreIds) {
  return currentWidgets().some((o) =>
    !ignoreIds.has(o.id) && o.grid && rectsOverlap(rect, o.grid));
}

/**
 * Snap an edge to a neighbour's edge when it's within one cell, and report the
 * lines to draw. Guides are what make a layout feel deliberate rather than
 * approximately-dragged.
 */
function snapAndGuide(rect, ignoreIds, cols) {
  const guides = { v: new Set(), h: new Set() };
  const others = currentWidgets().filter((o) => !ignoreIds.has(o.id) && o.grid);

  const vEdges = [0, cols];
  const hEdges = [0];
  for (const o of others) {
    vEdges.push(o.grid.x, o.grid.x + o.grid.w);
    hEdges.push(o.grid.y, o.grid.y + o.grid.h);
  }

  // Snap whichever of the two edges is closest, at most one cell away.
  const snapAxis = (lo, size, edges, max) => {
    let best = null;
    for (const e of edges) {
      for (const [edge, isStart] of [[lo, true], [lo + size, false]]) {
        const d = Math.abs(edge - e);
        if (d > 0 && d <= 1 && (!best || d < best.d)) best = { d, delta: e - edge, isStart, line: e };
      }
    }
    if (!best) return { lo, lines: [] };
    const next = clamp(lo + best.delta, 0, Math.max(0, max - size));
    return { lo: next, lines: [best.line] };
  };

  const sx = snapAxis(rect.x, rect.w, vEdges, cols);
  const sy = snapAxis(rect.y, rect.h, hEdges, Infinity);
  rect.x = sx.lo;
  rect.y = sy.lo;
  for (const l of sx.lines) guides.v.add(l);
  for (const l of sy.lines) guides.h.add(l);

  // Alignment (not snapping): show a line when edges already coincide.
  for (const o of others) {
    if (o.grid.x === rect.x || o.grid.x + o.grid.w === rect.x + rect.w) guides.v.add(o.grid.x === rect.x ? rect.x : rect.x + rect.w);
    if (o.grid.y === rect.y || o.grid.y + o.grid.h === rect.y + rect.h) guides.h.add(o.grid.y === rect.y ? rect.y : rect.y + rect.h);
  }
  return guides;
}

function drawGuides(guides, cols) {
  const layer = $("#guide-layer");
  if (!layer) return;
  layer.replaceChildren();
  if (!guides) return;
  for (const x of guides.v) {
    const g = document.createElement("div");
    g.className = "guide guide-v";
    g.style.left = `calc(${(x / cols) * 100}% - 0.5px)`;
    layer.appendChild(g);
  }
  for (const y of guides.h) {
    const g = document.createElement("div");
    g.className = "guide guide-h";
    g.style.top = `${y * (EDITOR_ROW + CANVAS_GAP)}px`;
    layer.appendChild(g);
  }
}

function showDragBadge(box, rect) {
  let badge = box.querySelector(".drag-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.className = "drag-badge";
    box.appendChild(badge);
  }
  badge.textContent = `${rect.w} × ${rect.h}  ·  x ${rect.x} y ${rect.y}`;
}

function startDrag(e, w, box, cols, mode, dir = "se") {
  if (e.target.closest(".box-btn, .live-poster-go")) return; // let buttons click
  if (e.button !== 0) return;
  e.preventDefault();
  const canvas = $("#canvas");
  const cellW = canvas.getBoundingClientRect().width / cols;
  const cellH = EDITOR_ROW + CANVAS_GAP;
  const start = { x: e.clientX, y: e.clientY };
  const orig = { ...w.grid };
  // Moving a multi-selection drags the whole group by the same delta.
  const group = mode === "move" && isSelected(w.id) && selectedWidgets().length > 1
    ? selectedWidgets() : [w];
  const groupOrig = new Map(group.map((g) => [g.id, { ...g.grid }]));
  const ignore = new Set(group.map((g) => g.id));

  box.setPointerCapture(e.pointerId);
  box.classList.add("dragging");
  let lastGood = new Map(group.map((g) => [g.id, { ...g.grid }]));

  const onMove = (ev) => {
    let dx = Math.round((ev.clientX - start.x) / cellW);
    let dy = Math.round((ev.clientY - start.y) / cellH);
    const freeform = ev.altKey; // Alt suspends snapping for a deliberate nudge

    let guides = null;
    if (mode === "move") {
      const lead = { ...groupOrig.get(w.id) };
      lead.x = clamp(lead.x + dx, 0, cols - lead.w);
      lead.y = Math.max(0, lead.y + dy);
      if (!freeform) guides = snapAndGuide(lead, ignore, cols);
      dx = lead.x - groupOrig.get(w.id).x;
      dy = lead.y - groupOrig.get(w.id).y;

      const next = group.map((g) => {
        const o = groupOrig.get(g.id);
        return { id: g.id, x: clamp(o.x + dx, 0, cols - o.w), y: Math.max(0, o.y + dy), w: o.w, h: o.h };
      });
      // Overlaps are blocked outright rather than flagged after the drop.
      const blocked = next.some((r) => collides(r, ignore));
      box.classList.toggle("blocked", blocked);
      if (!blocked) {
        for (const r of next) {
          const g = group.find((x) => x.id === r.id);
          g.grid.x = r.x; g.grid.y = r.y;
        }
        lastGood = new Map(group.map((g) => [g.id, { ...g.grid }]));
      }
    } else {
      const o = groupOrig.get(w.id);
      const rect = { ...o };
      if (dir.includes("e")) rect.w = clamp(o.w + dx, 1, cols - o.x);
      if (dir.includes("s")) rect.h = Math.max(1, o.h + dy);
      if (dir.includes("w")) {
        const nx = clamp(o.x + dx, 0, o.x + o.w - 1);
        rect.w = o.x + o.w - nx; rect.x = nx;
      }
      if (dir.includes("n")) {
        const ny = clamp(o.y + dy, 0, o.y + o.h - 1);
        rect.h = o.y + o.h - ny; rect.y = ny;
      }
      if (!freeform) guides = snapAndGuide(rect, ignore, cols);
      const blocked = collides(rect, ignore);
      box.classList.toggle("blocked", blocked);
      if (!blocked) {
        Object.assign(w.grid, rect);
        lastGood = new Map([[w.id, { ...w.grid }]]);
      }
    }

    for (const g of group) placeBox(canvas.querySelector(`[data-widget-id="${g.id}"]`) || box, g);
    drawGuides(guides, cols);
    showDragBadge(box, w.grid);
  };

  const onUp = () => {
    box.releasePointerCapture(e.pointerId);
    box.classList.remove("dragging", "blocked");
    box.removeEventListener("pointermove", onMove);
    box.removeEventListener("pointerup", onUp);
    drawGuides(null, cols);
    // Land on the last position that didn't collide.
    for (const g of group) if (lastGood.has(g.id)) Object.assign(g.grid, lastGood.get(g.id));

    const changed = group.some((g) => {
      const o = groupOrig.get(g.id);
      return o.x !== g.grid.x || o.y !== g.grid.y || o.w !== g.grid.w || o.h !== g.grid.h;
    });
    if (changed) {
      renderCanvas(); // re-render to grow the canvas if needed
      const resized = orig.w !== w.grid.w || orig.h !== w.grid.h;
      const what = group.length > 1 ? `${group.length} widgets` : (w.title || w.type);
      // One undo step per drag, not one per pointermove: the whole gesture
      // already mutated w.grid live, and this is the commit at the end of it.
      save(`${resized ? "resized" : "moved"} ${what}`);
    }
  };
  box.addEventListener("pointermove", onMove);
  box.addEventListener("pointerup", onUp);
}

// ---- widget list (compact, under the canvas) --------------------------------

let dragIndex = null;

function renderList() {
  const list = $("#widget-list");
  list.replaceChildren();
  const widgets = currentWidgets();
  if (!widgets.length) {
    list.appendChild(emptyState(
      "No widgets on this page",
      "Add a clock, the weather, a live radar embed — anything the dashboard can render.",
      button("+ Add widget", "btn primary small", () => openEditor(null)),
    ));
    return;
  }

  const q = ($("#widget-filter")?.value || "").trim().toLowerCase();
  const match = (w) => !q || [w.title, w.type, registry.get(w.type)?.meta?.label, w.id]
    .some((s) => String(s || "").toLowerCase().includes(q));
  const shown = widgets.filter(match);
  if (!shown.length) {
    list.appendChild(emptyState("Nothing matches “" + q + "”", "Clear the filter to see all widgets on this page."));
    return;
  }

  widgets.forEach((w, i) => {
    if (!match(w)) return;
    const plugin = registry.get(w.type);
    const row = document.createElement("div");
    row.className = "wrow" + (w.enabled === false ? " disabled" : "") + (state.editingId === w.id ? " selected" : "");
    row.draggable = true;
    row.innerHTML = `<span class="drag-grip" title="Drag to reorder">⠿</span><div class="winfo"><div class="wtitle"></div><div class="wtype"></div></div>`;
    row.querySelector(".wtitle").textContent = w.title || "(untitled)";
    row.querySelector(".wtype").textContent = `${(plugin?.meta?.label) || w.type} · ${w.id}`;
    const mk = (label, cls, fn) => { const b = document.createElement("button"); b.className = "btn small " + (cls || ""); b.textContent = label; b.onclick = fn; return b; };
    row.appendChild(mk(w.enabled === false ? "Enable" : "Disable", "", () => toggle(w.id)));
    row.appendChild(mk("Edit", "", () => openEditor(w.id)));
    row.appendChild(mk("Duplicate", "", () => duplicateWidget(w.id)));
    row.appendChild(mk("Copy to…", "", () => copyWidgetTo(w.id)));
    row.appendChild(mk("Delete", "danger", () => delWidget(w.id)));
    // drag-reorder
    row.addEventListener("dragstart", () => { dragIndex = i; row.classList.add("row-dragging"); });
    row.addEventListener("dragend", () => row.classList.remove("row-dragging"));
    row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("row-over"); });
    row.addEventListener("dragleave", () => row.classList.remove("row-over"));
    row.addEventListener("drop", (e) => { e.preventDefault(); row.classList.remove("row-over"); reorder(dragIndex, i); });
    list.appendChild(row);
  });
}

function reorder(from, to) {
  if (from == null || from === to) return;
  const ws = currentWidgets();
  if (from < 0 || from >= ws.length || to < 0 || to >= ws.length) return;
  const [moved] = ws.splice(from, 1);
  ws.splice(to, 0, moved);
  dragIndex = null;
  save(`reordered ${moved.title || moved.type}`);
}

function duplicateWidget(id) {
  const ws = currentWidgets();
  const w = ws.find((x) => x.id === id);
  if (!w) return;
  const copy = structuredClone(w);
  copy.id = `${w.type}-${Date.now().toString(36)}`;
  copy.title = (w.title || "") + " copy";
  copy.grid = { ...(w.grid || { x: 0, y: 0, w: 4, h: 3 }) };
  copy.grid.y = (copy.grid.y || 0) + (copy.grid.h || 3); // drop it just below
  ws.push(copy);
  save(`duplicated ${w.title || w.type}`);
}

async function copyWidgetTo(id) {
  const w = currentWidgets().find((x) => x.id === id);
  if (!w) return;
  const ps = pages();
  // Was a prompt() asking the user to type a page number from a text menu.
  const idx = await pickDialog({
    title: `Copy “${w.title || w.id}” to…`,
    options: ps.map((p, i) => ({
      value: i,
      label: p.name || "Page",
      hint: `${p.widgets?.length || 0} widget${(p.widgets?.length || 0) === 1 ? "" : "s"}`,
      disabled: i === state.activePage,
    })),
  });
  if (idx == null) return;
  const copy = structuredClone(w);
  copy.id = `${w.type}-${Date.now().toString(36)}`;
  (ps[idx].widgets || (ps[idx].widgets = [])).push(copy);
  save(`copied ${w.title || w.type} to “${ps[idx].name}”`);
  toast(`Copied to “${ps[idx].name}”`, "ok");
}

function toggle(id) {
  const w = currentWidgets().find((x) => x.id === id);
  if (!w) return;
  w.enabled = w.enabled === false;
  save(`${w.enabled ? "enabled" : "disabled"} ${w.title || w.type}`);
}
async function delWidget(id) {
  const ws = currentWidgets();
  const i = ws.findIndex((x) => x.id === id);
  if (i < 0) return;
  const label = ws[i].title || ws[i].id;
  const ok = await savebar.confirmDialog({
    title: "Delete widget?",
    message: `“${label}” will be removed from this page. You can undo this.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  ws.splice(i, 1);
  save(`deleted ${label}`);
}

// ---- widget editor (type + settings; grid handled on canvas) ----------------

function nextFreeRow() {
  return currentWidgets().reduce((m, w) => Math.max(m, (w.grid?.y || 0) + (w.grid?.h || 3)), 0);
}

async function openEditor(id) {
  const editor = $("#editor");
  const existing = currentWidgets().find((w) => w.id === id);
  let widget;
  if (existing) {
    widget = structuredClone(existing);
  } else {
    const type = await pickWidgetType();
    if (!type) return;
    widget = {
      id: "", type, title: registry.get(type)?.meta?.label || "",
      enabled: true, grid: { x: 0, y: nextFreeRow(), w: 4, h: 3 },
      // Defaults are materialised up front. The form used to *display* each
      // field's default but only write what was in the DOM, so a widget added
      // and saved untouched came out with an empty settings bag.
      settings: defaultSettings(type),
    };
    if (type === "heads-up") widget.pinned = true;
  }
  if (widget.type === "slideshow") {
    widget.slideshow = widget.slideshow || { enabled: true, durationSeconds: 30, slides: [] };
  }
  state.editingId = existing ? id : null;
  state.selection.clear();
  renderForm(editor, widget);
}

function renderForm(editor, widget) {
  const label = registry.get(widget.type)?.meta?.label || widget.type;
  openPanel(state.editingId ? `${widget.title || label}` : "Add widget");

  // Type is shown, not re-picked from a raw list: changing it throws away the
  // settings, so it goes through the same picker as adding.
  const typeRow = document.createElement("div");
  typeRow.className = "type-row";
  const typeName = document.createElement("div");
  typeName.className = "type-name";
  typeName.textContent = label;
  const typeDesc = document.createElement("div");
  typeDesc.className = "type-desc";
  typeDesc.textContent = registry.get(widget.type)?.meta?.description || widget.type;
  const typeText = document.createElement("div");
  typeText.className = "type-text";
  typeText.append(typeName, typeDesc);
  typeRow.append(typeText, button("Change…", "btn small ghost", async () => {
    const v = await pickWidgetType({ title: "Change widget type" });
    if (!v || v === widget.type) return;
    const next = gather(editor, widget);
    next.type = v;
    next.settings = defaultSettings(v);
    next.pinned = v === "heads-up" ? true : next.pinned;
    if (v !== "slideshow") next.slideshow = null;
    else next.slideshow = next.slideshow || { enabled: true, durationSeconds: 30, slides: [] };
    renderForm(editor, next);
  }));
  editor.appendChild(field("Type", typeRow));
  editor.appendChild(field("Title", input("text", widget.title, "title")));
  editor.appendChild(boolField("Enabled", widget.enabled !== false, "enabled"));
  editor.appendChild(boolField("Pin to all pages (overlay)", widget.pinned === true, "pinned"));
  if (widget.pinned) {
    editor.appendChild(noteEl("Pinned widgets stay visible during page rotation. Only one pinned widget is recommended."));
  }

  const plugin = registry.get(widget.type);
  const fields = (plugin?.schema?.fields || []).filter((f) => f.key !== "_slidesNote");
  if (fields.length) editor.appendChild(sectionTitle("Settings"));
  for (const f of fields) editor.appendChild(renderField(f, widget));

  editor.appendChild(field("Refresh seconds (blank = none)", input("number", widget.refreshSeconds ?? "", "refreshSeconds")));
  editor.appendChild(noteEl("Position & size are set by dragging on the layout canvas."));

  editor.appendChild(sectionTitle("Schedule"));
  editor.appendChild(noteEl("Hide this widget outside a time window (same rules as page schedules)."));
  appendScheduleFields(editor, widget.schedule || {}, "ws");

  editor.appendChild(sectionTitle("Variants"));
  editor.appendChild(noteEl("Named setting overrides for Scenes (match by label). First variant is the default when no scene is active. Overrides are a JSON object of settings keys."));
  appendVariantsFields(editor, widget);

  if (widget.type === "slideshow") {
    editor.appendChild(sectionTitle("Slides"));
    appendSlideshowFields(editor, widget);
  }

  const actions = document.createElement("div");
  actions.className = "editor-actions";
  actions.append(
    button("Cancel", "btn", () => { state.editingId = null; showDefault(); }),
    button("Save", "btn primary", () => commit(editor, widget)),
  );
  editor.appendChild(actions);
  editor._widget = widget;
}

function renderField(f, widget) {
  const val = widget.settings?.[f.key] ?? f.default ?? "";
  if (f.type === "note") return field("", noteEl(f.label));
  if (f.type === "boolean") return boolField(f.label, val === true || val === "true", "set-" + f.key);
  if (f.type === "textarea") return field(f.label, textarea(val, "set-" + f.key));
  if (f.type === "select") return field(f.label, select(f.options || [], val, null, "set-" + f.key));
  if (f.type === "number") return field(f.label, input("number", val, "set-" + f.key, f.placeholder));
  if (f.type === "password") {
    const inp = document.createElement("input");
    inp.type = "password";
    inp.dataset.name = "set-" + f.key;
    inp.placeholder = val ? "•••••• (leave blank to keep)" : (f.placeholder || "Paste key…");
    return field(f.label, inp);
  }
  if (f.type === "stock-picker") return field(f.label, stockPicker(widget));
  if (f.type === "url-presets") return field(f.label, urlPresets(f, val));
  if (f.type === "embed-presets") return field(f.label, embedPresets(f, val));
  return field(f.label, input("text", val, "set-" + f.key, f.placeholder));
}

function gather(editor, base) {
  const w = base || editor._widget;
  const get = (name) => editor.querySelector(`[data-name="${name}"]`);
  const title = get("title"); if (title) w.title = title.value;
  const en = get("enabled"); if (en) w.enabled = en.checked;
  const pin = get("pinned"); if (pin) w.pinned = pin.checked;
  const rs = get("refreshSeconds"); w.refreshSeconds = rs && rs.value !== "" ? Number(rs.value) : null;
  // grid is preserved as-is (edited on the canvas, not here)
  w.settings = w.settings || {};
  const plugin = registry.get(w.type);
  for (const f of plugin?.schema?.fields || []) {
    if (f.type === "note" || f.type === "stock-picker") continue;
    const node = get("set-" + f.key);
    if (!node) continue;
    if (f.type === "boolean") w.settings[f.key] = node.checked;
    else if (f.type === "password") { if (node.value) w.settings[f.key] = node.value; }
    else if (f.type === "number") w.settings[f.key] = node.value === "" ? null : Number(node.value);
    else w.settings[f.key] = node.value;
  }
  w.schedule = gatherSchedule(editor, "ws");
  w.variants = gatherVariants(editor);
  if (w.type === "slideshow") w.slideshow = gatherSlideshow(editor, w);
  else w.slideshow = null;
  return w;
}

async function commit(editor, widget) {
  try {
    gatherVariants(editor, { strict: true });
  } catch (e) {
    toast(e.message || String(e), "err");
    return;
  }
  const w = gather(editor, widget);
  if (!w.id) w.id = `${w.type}-${Date.now().toString(36)}`;
  if (w.pinned) {
    const others = pages().flatMap((p) => p.widgets || []).filter((x) => x.pinned && x.id !== w.id);
    if (others.length) toast("Another widget is already pinned — only one overlay is recommended", "");
  }
  const ws = currentWidgets();
  const idx = ws.findIndex((x) => x.id === state.editingId);
  const isNew = idx < 0;
  if (!isNew) ws[idx] = w; else ws.push(w);
  showDefault();
  state.editingId = null;
  save(`${isNew ? "added" : "edited"} ${w.title || w.type}`);
}

// ---- staging (no network; the store owns history, savebar owns the wire) -----
//
// Callers mutate `state.config` in place and then call save("what they did").
// The label is what the user sees in the changes list and the undo toast, so it
// should read as an action ("moved Weather"), not as a field path.

function save(label, opts) {
  store.commitValue(label || "edited the dashboard", state.config, opts);
}

/** Replace the working copy's contents while keeping its object identity, so
 *  closures that captured `state.config` keep pointing at the live config. */
function adoptConfig(next) {
  if (!state.config) { state.config = clone(next); return; }
  for (const k of Object.keys(state.config)) delete state.config[k];
  Object.assign(state.config, clone(next));
}

/** Called by the store after undo/redo/discard/save/external change. */
function onConfigReplaced(next) {
  adoptConfig(next);
  if (!pages().length) pages().push({ id: "page-1", name: "Home", widgets: [] });
  state.activePage = Math.min(state.activePage, pages().length - 1);
  $("#version").textContent = "v" + state.config.version;
  state.editingId = null;
  renderAll();
  showDefault();
}

// ---- page rotation (not the slideshow *widget*) -----------------------------

function rotationPageOrder() { return rotationPages(state.config); }

function openRotation() {
  state.editingId = null;
  const editor = openPanel("Page rotation", { section: "rotation" });
  editor.appendChild(noteEl("Cycle through pages on a timer. This is separate from the Slideshow widget, which rotates slides inside one tile."));
  const r = rotation();
  editor.appendChild(boolField("Enable page rotation", r.enabled === true, "rot-enabled"));
  editor.appendChild(field("Default seconds per page", input("number", r.defaultDurationSeconds ?? 30, "rot-default")));
  const transOpts = ["random", "off", "fade", "slide-left", "slide-right", "slide-up", "slide-down",
    "zoom-in", "zoom-out", "wipe-left", "wipe-right", "blur-fade", "scale-rotate"];
  editor.appendChild(field("Page transition", select(
    transOpts,
    state.config.settings?.pageTransition ?? "random",
    null,
    "rot-transition",
  )));
  editor.appendChild(noteEl("Random picks a different animation each page change. Off = instant swap."));

  editor.appendChild(sectionTitle("Pages in rotation"));
  editor.appendChild(noteEl(
    "Rotation follows the page bar — drag the tabs up there to change the order. " +
    "Blank duration = use the default above."));
  if (hasCustomOrder(state.config)) {
    editor.appendChild(noteEl(
      "⚠ This config has a separate rotation order left over from an older version. " +
      "Saving here drops it and follows the page bar instead."));
  }

  // Order is derived, so this list is read-only apart from per-page duration.
  const draft = rotationPageOrder().map((p) => ({
    id: p.id,
    name: p.name || "Page",
    durationSeconds: p.durationSeconds ?? "",
  }));
  const list = document.createElement("div");
  list.className = "rot-order-list";
  list.dataset.name = "rot-order";
  draft.forEach((row, i) => {
    const el = document.createElement("div");
    el.className = "rot-order-row";
    el.dataset.pageId = row.id;
    const pos = document.createElement("span");
    pos.className = "badge";
    pos.textContent = String(i + 1);
    const name = document.createElement("div");
    name.className = "rot-order-name";
    name.textContent = row.name;
    const dur = input("number", row.durationSeconds, `rot-dur-${row.id}`);
    dur.className = "rot-order-dur";
    dur.placeholder = String(r.defaultDurationSeconds ?? 30);
    dur.oninput = () => { row.durationSeconds = dur.value; };
    el.append(pos, name, field("Seconds", dur));
    list.appendChild(el);
  });
  editor.appendChild(list);

  const actions = document.createElement("div"); actions.className = "editor-actions";
  actions.append(
    button("Cancel", "btn", () => showDefault()),
    button("Save", "btn primary", () => {
      r.enabled = editor.querySelector('[data-name="rot-enabled"]').checked;
      const d = Number(editor.querySelector('[data-name="rot-default"]').value);
      r.defaultDurationSeconds = Math.max(2, d || 30);
      const trans = editor.querySelector('[data-name="rot-transition"]')?.value;
      if (trans) {
        const s = state.config.settings || (state.config.settings = {});
        s.pageTransition = trans;
      }
      syncRotationOrder(state.config);
      const byId = new Map(pages().map((p) => [p.id, p]));
      for (const row of draft) {
        const p = byId.get(row.id);
        if (!p) continue;
        const raw = String(row.durationSeconds ?? "").trim();
        p.durationSeconds = raw === "" ? null : Math.max(2, Number(raw) || 2);
      }
      showDefault();
      save("changed page rotation");
    }),
  );
  editor.appendChild(actions);
}

// ---- alert engine settings + active banners ---------------------------------

function alertsSettings() {
  const s = state.config.settings || (state.config.settings = {});
  return s.alerts || (s.alerts = {
    infoTtlSeconds: 90, warningTtlSeconds: 0, dangerTtlSeconds: 0,
    octoprintEnabled: true, nwsEnabled: true, spaceEnabled: true,
    nwsMinSeverity: "info", kpThreshold: 6, spaceTtlSeconds: 3600,
  });
}

function openAlerts() {
  state.editingId = null;
  const a = alertsSettings();
  const editor = openPanel("Alerts", { section: "alerts" });
  editor.appendChild(noteEl("Sources push banners to every display. Auto-dismiss times apply to severity (including NWS, capped by the official expiry). ✕ clears every display and stays dismissed until NWS cancels that alert."));

  editor.appendChild(sectionTitle("Sources"));
  editor.appendChild(boolField("OctoPrint print transitions", a.octoprintEnabled !== false, "al-op"));
  editor.appendChild(boolField("NWS severe weather", a.nwsEnabled !== false, "al-nws"));
  editor.appendChild(boolField("Space weather (geomagnetic storm)", a.spaceEnabled !== false, "al-space"));

  editor.appendChild(sectionTitle("NWS"));
  editor.appendChild(field("Minimum severity", select(
    [
      { value: "info", label: "Info and above" },
      { value: "warning", label: "Warning and above" },
      { value: "danger", label: "Danger only" },
    ],
    a.nwsMinSeverity || "info",
    null,
    "al-nws-min",
  )));

  editor.appendChild(sectionTitle("Space weather"));
  editor.appendChild(field("Kp threshold (fire when ≥)", input("number", a.kpThreshold ?? 6, "al-kp")));
  editor.appendChild(field("Space alert lifetime (seconds, 0 = use warning TTL)", input("number", a.spaceTtlSeconds ?? 3600, "al-space-ttl")));
  editor.appendChild(noteEl("Hysteresis resets when Kp drops below threshold − 1 (same as before for the default of 6)."));

  editor.appendChild(sectionTitle("Auto-dismiss"));
  editor.appendChild(field("Info alerts (seconds, 0 = keep)", input("number", a.infoTtlSeconds ?? 90, "al-info")));
  editor.appendChild(field("Warning alerts (seconds, 0 = keep)", input("number", a.warningTtlSeconds ?? 0, "al-warning")));
  editor.appendChild(field("Danger alerts (seconds, 0 = keep)", input("number", a.dangerTtlSeconds ?? 0, "al-danger")));
  editor.appendChild(noteEl("Defaults: info = 90s, warning/danger = keep until dismissed. Saving new times also updates alerts already on screen. Use Test alert to preview."));

  editor.appendChild(sectionTitle("Active on displays"));
  const activeHost = document.createElement("div");
  activeHost.className = "alert-active-list";
  activeHost.appendChild(noteEl("Loading…"));
  editor.appendChild(activeHost);
  const refreshActive = async () => {
    try {
      const r = await fetch("/api/alerts");
      const d = await r.json();
      const list = d.alerts || [];
      activeHost.replaceChildren();
      if (!list.length) {
        activeHost.appendChild(noteEl("No active banners right now."));
      } else {
        for (const al of list) {
          const row = document.createElement("div");
          row.className = "alert-active-row";
          const info = document.createElement("div");
          info.className = "alert-active-info";
          const title = document.createElement("div");
          title.className = "alert-active-title";
          title.textContent = `${al.severity || "info"} · ${al.title || al.id}`;
          const msg = document.createElement("div");
          msg.className = "alert-active-msg";
          msg.textContent = al.message || al.source || "";
          info.append(title, msg);
          row.append(
            info,
            button("Dismiss", "btn small danger", async () => {
              await fetch("/api/alerts/" + encodeURIComponent(al.id), { method: "DELETE" });
              refreshActive();
            }),
          );
          activeHost.appendChild(row);
        }
        activeHost.appendChild(button("Dismiss all", "btn small danger", async () => {
          const ok = await savebar.confirmDialog({
            title: "Dismiss all alerts?",
            message: "Every active alert is cleared from all displays immediately. This can't be undone.",
            confirmLabel: "Dismiss all",
            danger: true,
          });
          if (!ok) return;
          await api.clearAlerts();
          refreshActive();
        }));
      }
    } catch (e) {
      activeHost.replaceChildren(noteEl("Could not load active alerts: " + e.message));
    }
  };
  refreshActive();

  const actions = document.createElement("div"); actions.className = "editor-actions";
  actions.append(
    button("Cancel", "btn", () => showDefault()),
    button("Save", "btn primary", () => {
      const readInt = (name) => Math.max(0, Math.round(Number(editor.querySelector(`[data-name="${name}"]`).value) || 0));
      const readNum = (name, fallback) => {
        const v = Number(editor.querySelector(`[data-name="${name}"]`).value);
        return Number.isFinite(v) ? v : fallback;
      };
      a.octoprintEnabled = editor.querySelector('[data-name="al-op"]')?.checked !== false;
      a.nwsEnabled = editor.querySelector('[data-name="al-nws"]')?.checked !== false;
      a.spaceEnabled = editor.querySelector('[data-name="al-space"]')?.checked !== false;
      a.nwsMinSeverity = editor.querySelector('[data-name="al-nws-min"]')?.value || "info";
      a.kpThreshold = Math.min(9, Math.max(0, readNum("al-kp", 6)));
      a.spaceTtlSeconds = readInt("al-space-ttl");
      a.infoTtlSeconds = readInt("al-info");
      a.warningTtlSeconds = readInt("al-warning");
      a.dangerTtlSeconds = readInt("al-danger");
      showDefault();
      save("changed alert rules");
    }),
  );
  editor.appendChild(actions);
}

// ---- scenes (named context presets) -----------------------------------------

function openScenes() {
  state.editingId = null;
  const editor = openPanel("Scenes", { section: "scenes" });
  editor.appendChild(noteEl("Scenes flip pages, theme, widget variants, and rotation in one shot. Activate holds until you Clear; otherwise schedules auto-switch (first matching scene in list order wins)."));

  const hold = !!state.config.sceneManualHold;
  const activeId = state.config.activeSceneId || null;
  const status = document.createElement("div");
  status.className = "note";
  if (hold && activeId) {
    const sc = scenes().find((s) => s.id === activeId);
    status.textContent = `Manual hold: “${sc?.name || activeId}” (schedules paused until Clear).`;
  } else {
    status.textContent = "Following schedules (no manual hold). Outside schedule windows the dashboard uses the baseline layout.";
  }
  editor.appendChild(status);

  const toolbar = document.createElement("div");
  toolbar.style.display = "flex";
  toolbar.style.gap = "8px";
  toolbar.style.flexWrap = "wrap";
  toolbar.style.margin = "8px 0";
  toolbar.append(
    button("+ New scene", "btn primary small", () => openSceneEditor(null)),
    button("Clear / follow schedules", "btn small", () => {
      state.config.activeSceneId = null;
      state.config.sceneManualHold = false;
      save("cleared the active scene");
      openScenes();
    }),
  );
  editor.appendChild(toolbar);

  const list = document.createElement("div");
  list.className = "device-list";
  if (!scenes().length) {
    editor.appendChild(noteEl("No scenes yet — create Morning, Print watch, Night ambient, etc."));
  }
  for (const sc of scenes()) {
    list.appendChild(sceneRow(sc));
  }
  editor.appendChild(list);

  const actions = document.createElement("div"); actions.className = "editor-actions";
  actions.append(button("Close", "btn", () => showDefault()));
  editor.appendChild(actions);
}

function sceneRow(sc) {
  const row = document.createElement("div");
  row.className = "device-row" + (state.config.sceneManualHold && state.config.activeSceneId === sc.id ? " online" : "");
  const info = document.createElement("div");
  info.className = "device-info";
  const name = document.createElement("div");
  name.className = "device-name";
  name.textContent = sc.name || sc.id;
  const meta = document.createElement("div");
  meta.className = "device-meta";
  const bits = [];
  if (sc.pageIds?.length) bits.push(`${sc.pageIds.length} page(s)`);
  else bits.push("all pages");
  if (sc.theme?.mode || sc.theme?.accent) bits.push("theme");
  if (sc.variantLabel) bits.push(`variant “${sc.variantLabel}”`);
  if (sc.schedule?.enabled) bits.push("scheduled");
  meta.textContent = bits.join(" · ");
  info.append(name, meta);

  const controls = document.createElement("div");
  controls.className = "device-controls";
  controls.append(
    button("Activate", "btn small primary", () => {
      state.config.activeSceneId = sc.id;
      state.config.sceneManualHold = true;
      save(`activated scene “${sc.name}”`);
      openScenes();
    }),
    button("Edit", "btn small", () => openSceneEditor(sc.id)),
    button("Delete", "btn small danger", async () => {
      const ok = await savebar.confirmDialog({
        title: "Delete scene?",
        message: `“${sc.name}” will be removed. You can undo this.`,
        confirmLabel: "Delete scene",
        danger: true,
      });
      if (!ok) return;
      const idx = scenes().findIndex((s) => s.id === sc.id);
      if (idx >= 0) scenes().splice(idx, 1);
      if (state.config.activeSceneId === sc.id) {
        state.config.activeSceneId = null;
        state.config.sceneManualHold = false;
      }
      save(`deleted scene “${sc.name}”`);
      openScenes();
    }),
  );
  row.append(info, controls);
  return row;
}

function openSceneEditor(sceneId) {
  state.editingId = null;
  const existing = sceneId ? scenes().find((s) => s.id === sceneId) : null;
  const editor = openPanel(existing ? `Scene — ${existing.name}` : "New scene", { section: "scenes" });
  const draft = existing
    ? JSON.parse(JSON.stringify(existing))
    : {
      id: "scene-" + Date.now().toString(36),
      name: "New scene",
      pageIds: [],
      theme: null,
      variantLabel: null,
      rotation: null,
      schedule: null,
    };

  const h = document.createElement("h2");
  h.textContent = existing ? `Edit scene — ${draft.name}` : "New scene";
  h.style.margin = "0 0 6px";
  editor.appendChild(h);

  editor.appendChild(field("Name", input("text", draft.name || "", "sc-name")));

  editor.appendChild(sectionTitle("Pages"));
  editor.appendChild(noteEl("Leave all unchecked to include every page. Checking any page restricts the scene to those pages only."));
  const pageWrap = document.createElement("div");
  pageWrap.className = "day-picker";
  pageWrap.dataset.name = "sc-pages";
  const pageChips = pages().map((p) => {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "day-chip" + (draft.pageIds?.includes(p.id) ? " on" : "");
    c.textContent = p.name || p.id;
    c.dataset.pageId = p.id;
    c.onclick = () => c.classList.toggle("on");
    pageWrap.appendChild(c);
    return c;
  });
  editor.appendChild(pageWrap);

  editor.appendChild(sectionTitle("Theme overlay"));
  const themeMode = draft.theme?.mode || "";
  editor.appendChild(field("Mode override", select(
    [
      { value: "", label: "No change" },
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
      { value: "auto", label: "Auto" },
    ],
    themeMode,
    null,
    "sc-theme-mode",
  )));
  editor.appendChild(field("Accent override (blank = no change)", input("text", draft.theme?.accent || "", "sc-theme-accent", "#4aa3ff")));

  editor.appendChild(sectionTitle("Variants & rotation"));
  editor.appendChild(field("Variant label (blank = none)", input("text", draft.variantLabel || "", "sc-variant", "night")));
  editor.appendChild(noteEl("Widgets that define a variant with this label switch to it while the scene is active."));
  const rotEn = draft.rotation?.enabled;
  editor.appendChild(field("Rotation override", select(
    [
      { value: "", label: "No change" },
      { value: "on", label: "Force slideshow on" },
      { value: "off", label: "Force slideshow off" },
    ],
    rotEn === true ? "on" : rotEn === false ? "off" : "",
    null,
    "sc-rot-enabled",
  )));
  editor.appendChild(field("Default seconds/page override (blank = no change)", input("number", draft.rotation?.defaultDurationSeconds ?? "", "sc-rot-secs")));

  editor.appendChild(sectionTitle("Schedule (auto-activate)"));
  appendScheduleFields(editor, draft.schedule || {}, "sc");

  const actions = document.createElement("div"); actions.className = "editor-actions";
  actions.append(
    button("Cancel", "btn", () => openScenes()),
    button("Save scene", "btn primary", async () => {
      draft.name = editor.querySelector('[data-name="sc-name"]')?.value?.trim() || "Scene";
      draft.pageIds = pageChips.filter((c) => c.classList.contains("on")).map((c) => c.dataset.pageId);
      const mode = editor.querySelector('[data-name="sc-theme-mode"]')?.value || "";
      const accent = editor.querySelector('[data-name="sc-theme-accent"]')?.value?.trim() || "";
      draft.theme = (mode || accent) ? { mode: mode || null, accent: accent || null } : null;
      const vl = editor.querySelector('[data-name="sc-variant"]')?.value?.trim() || "";
      draft.variantLabel = vl || null;
      const rotSel = editor.querySelector('[data-name="sc-rot-enabled"]')?.value || "";
      const rotSecsRaw = editor.querySelector('[data-name="sc-rot-secs"]')?.value;
      const rotSecs = rotSecsRaw === "" || rotSecsRaw == null ? null : Math.max(2, Number(rotSecsRaw) || 2);
      if (rotSel === "" && rotSecs == null) draft.rotation = null;
      else {
        draft.rotation = {
          enabled: rotSel === "on" ? true : rotSel === "off" ? false : null,
          defaultDurationSeconds: rotSecs,
        };
      }
      draft.schedule = gatherSchedule(editor, "sc");
      const idx = scenes().findIndex((s) => s.id === draft.id);
      const isNew = idx < 0;
      if (!isNew) scenes()[idx] = draft;
      else scenes().push(draft);
      save(`${isNew ? "added" : "edited"} scene “${draft.name}”`);
      openScenes();
    }),
  );
  editor.appendChild(actions);
}

// ---- inspector + rail -------------------------------------------------------
//
// The inspector is always on screen and always shows *something*; there is no
// panel to open or close, so nothing can silently destroy an unsaved form the
// way the old single #editor slot did. Each surface declares whether it stages
// into the config or applies immediately — the old Alerts panel mixed both with
// no way to tell which was which.

const RAIL = [
  { id: "pages",      icon: "▤", label: "Pages",       open: () => openPageSettings() },
  { id: "rotation",   icon: "⏱", label: "Rotation",    open: openRotation },
  { id: "scenes",     icon: "◲", label: "Scenes",      open: openScenes },
  { sep: true },
  { id: "appearance", icon: "◈", label: "Appearance",  open: openLayout },
  { id: "alerts",     icon: "⚑", label: "Alerts",      open: openAlerts },
  { id: "displays",   icon: "⬒", label: "Displays",    open: openDisplays },
  { sep: true },
  { id: "keys",       icon: "🔑", label: "API keys",   open: openKeys },
  { id: "backups",    icon: "⌛", label: "Backups",     open: openBackups },
  { id: "system",     icon: "⚙", label: "System",      open: openSystem },
];

let activeSection = "pages";

function renderRail() {
  const rail = $("#rail");
  rail.replaceChildren();
  for (const item of RAIL) {
    if (item.sep) {
      const s = document.createElement("div");
      s.className = "rail-sep";
      rail.appendChild(s);
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rail-btn";
    b.dataset.label = item.label;
    b.dataset.section = item.id;
    b.textContent = item.icon;
    b.setAttribute("aria-label", item.label);
    b.setAttribute("aria-current", String(activeSection === item.id));
    b.onclick = () => { activeSection = item.id; renderRail(); item.open(); };
    rail.appendChild(b);
  }
}

/** Clear the inspector and title it. Returns the body to append into. */
function openPanel(title, { scope = "staged", section = null } = {}) {
  if (section) { activeSection = section; renderRail(); }
  // The canvas and the strip both show what's selected, and the selection is
  // whatever the inspector is displaying — so they refresh together with it.
  renderCanvas();
  renderList();
  const editor = $("#editor");
  editor.replaceChildren();
  editor.scrollTop = 0;
  $("#inspector-title").textContent = title;
  const pill = $("#inspector-scope");
  pill.textContent = scope === "immediate" ? "Applies immediately" : "Staged";
  pill.className = "badge scope-pill " + (scope === "immediate" ? "immediate warn" : "staged");
  return editor;
}

/** What the inspector falls back to: the selected widget, else the page. */
function showDefault() {
  state.editingId = null;
  state.selection.clear();
  openPageSettings();
}

// ---- bulk selection toolbar -------------------------------------------------

function updateBulkBar() {
  const host = $("#bulk-bar");
  if (!host) return;
  const n = state.selection.size;
  host.classList.toggle("hidden", n < 2);
  if (n < 2) return;
  host.replaceChildren();
  const count = document.createElement("span");
  count.className = "bulk-count";
  count.textContent = `${n} selected`;
  host.appendChild(count);

  const act = (label, fn, cls = "ghost") => host.appendChild(button(label, "btn small " + cls, fn));
  act("Align left", () => alignSelection("left"));
  act("Align top", () => alignSelection("top"));
  act("Same width", () => alignSelection("width"));
  act("Disable", () => bulkToggle(false));
  act("Enable", () => bulkToggle(true));
  act("Copy to…", () => bulkCopyTo());
  act("Delete", () => bulkDelete(), "danger");
  act("Clear", () => showDefault());
}

/** The inspector when several widgets are selected — a form makes no sense. */
function openBulk() {
  const ws = selectedWidgets();
  const editor = openPanel(`${ws.length} widgets selected`);
  editor.appendChild(noteEl("Move them together by dragging any one, or nudge with the arrow keys. Bulk actions are on the toolbar above the canvas."));
  const list = document.createElement("div");
  list.className = "list";
  for (const w of ws) {
    const row = document.createElement("div");
    row.className = "list-row";
    const main = document.createElement("div");
    main.className = "list-row-main";
    const t = document.createElement("div");
    t.className = "list-row-title";
    t.textContent = w.title || w.id;
    const m = document.createElement("div");
    m.className = "list-row-meta";
    m.textContent = `${registry.get(w.type)?.meta?.label || w.type} · ${w.grid.w}×${w.grid.h}`;
    main.append(t, m);
    row.append(main, button("Edit only this", "btn small ghost", () => selectOnly(w.id)));
    list.appendChild(row);
  }
  editor.appendChild(list);
}

function alignSelection(how) {
  const ws = selectedWidgets();
  if (ws.length < 2) return;
  if (how === "left") {
    const x = Math.min(...ws.map((w) => w.grid.x));
    for (const w of ws) w.grid.x = x;
  } else if (how === "top") {
    const y = Math.min(...ws.map((w) => w.grid.y));
    for (const w of ws) w.grid.y = y;
  } else if (how === "width") {
    const wide = Math.max(...ws.map((w) => w.grid.w));
    const cols = state.config.settings?.columns || 12;
    for (const w of ws) w.grid.w = Math.min(wide, cols - w.grid.x);
  }
  renderCanvas();
  save(`aligned ${ws.length} widgets`);
}

function bulkToggle(enabled) {
  const ws = selectedWidgets();
  for (const w of ws) w.enabled = enabled;
  renderCanvas(); renderList();
  save(`${enabled ? "enabled" : "disabled"} ${ws.length} widgets`);
}

async function bulkDelete() {
  const ws = selectedWidgets();
  const ok = await savebar.confirmDialog({
    title: `Delete ${ws.length} widgets?`,
    message: "They'll be removed from this page. You can undo this.",
    confirmLabel: `Delete ${ws.length}`,
    danger: true,
  });
  if (!ok) return;
  const ids = new Set(ws.map((w) => w.id));
  const list = currentWidgets();
  for (let i = list.length - 1; i >= 0; i--) if (ids.has(list[i].id)) list.splice(i, 1);
  showDefault();
  save(`deleted ${ws.length} widgets`);
}

async function bulkCopyTo() {
  const ws = selectedWidgets();
  const ps = pages();
  const idx = await pickDialog({
    title: `Copy ${ws.length} widgets to…`,
    options: ps.map((p, i) => ({
      value: i, label: p.name || "Page",
      hint: `${p.widgets?.length || 0} widget${(p.widgets?.length || 0) === 1 ? "" : "s"}`,
      disabled: i === state.activePage,
    })),
  });
  if (idx == null) return;
  for (const w of ws) {
    const copy = structuredClone(w);
    copy.id = `${w.type}-${Math.random().toString(36).slice(2, 8)}`;
    (ps[idx].widgets || (ps[idx].widgets = [])).push(copy);
  }
  save(`copied ${ws.length} widgets to “${ps[idx].name}”`);
  toast(`Copied to “${ps[idx].name}”`, "ok");
}

/** Which variant actually renders right now — the rule is otherwise invisible. */
function activeVariantLabel(w) {
  const variants = w.variants || [];
  if (!variants.length) return null;
  const sceneLabel = scenes().find((s) => s.id === state.config.activeSceneId)?.variantLabel;
  const active = (sceneLabel && variants.find((v) => v.label === sceneLabel)) || variants[0];
  return active?.label || "variant 1";
}

// ---- widget picker ----------------------------------------------------------
//
// Replaces a flat <select> of 19 raw type keys. Every plugin already carried a
// label, a description and a category; none of it reached the UI, so choosing a
// widget meant recognising strings like "heads-up" and "space-imagery".

let missingKeys = new Set();   // global API keys that aren't configured

async function refreshMissingKeys() {
  try {
    const res = await api.loadSecrets();
    const set = new Set();
    for (const [name, meta] of Object.entries(res.keys || res || {})) {
      const isSet = typeof meta === "object" ? (meta.set ?? meta.configured) : !!meta;
      if (!isSet) set.add(name);
    }
    missingKeys = set;
  } catch { /* the picker still works without the badge */ }
}

/** Resolves to a chosen type, or null. `exclude` drops types (slides can't nest). */
function pickWidgetType({ title = "Add widget", exclude = [] } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const all = catalog().filter((i) => !exclude.includes(i.type));
    const body = document.createElement("div");
    body.className = "picker";

    const searchWrap = document.createElement("label");
    searchWrap.className = "search picker-search";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.placeholder = "Search widgets…";
    searchInput.setAttribute("aria-label", "Search widgets");
    searchWrap.appendChild(searchInput);
    body.appendChild(searchWrap);

    const results = document.createElement("div");
    results.className = "picker-results";
    body.appendChild(results);

    let flat = [];
    let cursor = 0;

    const card = (item) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "picker-card";
      b.dataset.type = item.type;

      const head = document.createElement("div");
      head.className = "picker-card-head";
      const name = document.createElement("span");
      name.className = "picker-card-label";
      name.textContent = item.label;
      head.appendChild(name);
      // Surface the needs-a-key state here, at the moment of choosing, rather
      // than after the widget is on the page rendering an empty state.
      if (item.needsGlobalKey && missingKeys.has(item.needsGlobalKey)) {
        const badge = document.createElement("span");
        badge.className = "badge warn-pill picker-badge";
        badge.textContent = "Needs " + item.needsGlobalKey;
        head.appendChild(badge);
      } else if (item.needsWidgetSecret) {
        const badge = document.createElement("span");
        badge.className = "badge picker-badge";
        badge.textContent = "Needs an API key";
        head.appendChild(badge);
      }
      b.appendChild(head);

      const desc = document.createElement("div");
      desc.className = "picker-card-desc";
      desc.textContent = item.description || item.type;
      b.appendChild(desc);

      b.onclick = () => { close(); done(item.type); };
      return b;
    };

    const draw = () => {
      results.replaceChildren();
      const q = searchInput.value;
      const matched = search(q, all);
      flat = matched;
      cursor = 0;
      if (!matched.length) {
        results.appendChild(emptyState(`Nothing matches “${q}”`, "Try a shorter word, or the widget's type name."));
        return;
      }
      if (q.trim()) {
        const grid = document.createElement("div");
        grid.className = "picker-grid";
        for (const it of matched) grid.appendChild(card(it));
        results.appendChild(grid);
      } else {
        for (const g of grouped(matched)) {
          results.appendChild(sectionTitle(g.label));
          const grid = document.createElement("div");
          grid.className = "picker-grid";
          for (const it of g.items) grid.appendChild(card(it));
          results.appendChild(grid);
        }
      }
      highlight();
    };

    const highlight = () => {
      const cards = [...results.querySelectorAll(".picker-card")];
      cards.forEach((c, i) => c.classList.toggle("cursor", i === cursor));
      cards[cursor]?.scrollIntoView({ block: "nearest" });
    };

    searchInput.addEventListener("input", draw);
    searchInput.addEventListener("keydown", (e) => {
      const cards = [...results.querySelectorAll(".picker-card")];
      if (e.key === "ArrowDown") { e.preventDefault(); cursor = Math.min(cursor + 1, cards.length - 1); highlight(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); cursor = Math.max(cursor - 1, 0); highlight(); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const t = cards[cursor]?.dataset.type;
        if (t) { close(); done(t); }
      }
    });

    const close = savebar.openModal({
      title,
      body,
      wide: true,
      actions: [{ label: "Cancel", cls: "btn", onClick: (c) => { c(); done(null); } }],
    });
    draw();
    requestAnimationFrame(() => searchInput.focus());
  });
}

// ---- command palette --------------------------------------------------------
// Every action, page, widget and section behind one fuzzy search. This is what
// finally makes a buried setting findable by name.

function openPalette() {
  let settled = false;
  const done = () => { settled = true; };

  const commands = [
    ...RAIL.filter((r) => !r.sep).map((r) => ({
      label: r.label, group: "Go to", run: () => { activeSection = r.id; renderRail(); r.open(); },
    })),
    { label: "Add widget", group: "Action", run: () => openEditor(null) },
    { label: "Tidy up layout", group: "Action", run: tidyUp },
    { label: "Toggle live canvas", group: "Action", run: () => $("#btn-live").click() },
    { label: "Toggle page preview", group: "Action", run: togglePreview },
    { label: "Save changes", group: "Action", run: () => savebar.saveNow() },
    { label: "Add page", group: "Action", run: addPage },
    ...pages().map((p, i) => ({
      label: p.name || "Page", group: "Page",
      run: () => { state.activePage = i; renderAll(); openPageSettings(i); },
    })),
    ...currentWidgets().map((w) => ({
      label: w.title || w.id, group: "Widget on this page",
      hint: registry.get(w.type)?.meta?.label || w.type,
      run: () => selectOnly(w.id),
    })),
  ];

  const body = document.createElement("div");
  body.className = "picker";
  const searchWrap = document.createElement("label");
  searchWrap.className = "search picker-search";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Search actions, pages, widgets…";
  input.setAttribute("aria-label", "Search commands");
  searchWrap.appendChild(input);
  body.appendChild(searchWrap);
  const results = document.createElement("div");
  results.className = "palette-results";
  body.appendChild(results);

  let flat = [], cursor = 0;

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    flat = commands.filter((c) =>
      !q || c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
        || (c.hint || "").toLowerCase().includes(q));
    cursor = 0;
    results.replaceChildren();
    if (!flat.length) {
      results.appendChild(emptyState(`Nothing matches “${input.value}”`, null));
      return;
    }
    let lastGroup = null;
    for (const [i, c] of flat.entries()) {
      if (c.group !== lastGroup) {
        results.appendChild(sectionTitle(c.group));
        lastGroup = c.group;
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = "palette-row";
      row.dataset.index = i;
      const l = document.createElement("span");
      l.textContent = c.label;
      row.appendChild(l);
      if (c.hint) {
        const h = document.createElement("span");
        h.className = "palette-hint";
        h.textContent = c.hint;
        row.appendChild(h);
      }
      row.onclick = () => { close(); done(); c.run(); };
      results.appendChild(row);
    }
    highlight();
  };
  const highlight = () => {
    const rows = [...results.querySelectorAll(".palette-row")];
    rows.forEach((r, i) => r.classList.toggle("cursor", i === cursor));
    rows[cursor]?.scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("input", draw);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); cursor = Math.min(cursor + 1, flat.length - 1); highlight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cursor = Math.max(cursor - 1, 0); highlight(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const c = flat[cursor];
      if (c) { close(); done(); c.run(); }
    }
  });

  const close = savebar.openModal({
    title: "Command palette",
    body,
    actions: [{ label: "Close", cls: "btn", onClick: (c) => { c(); done(); } }],
  });
  draw();
  requestAnimationFrame(() => input.focus());
}

// ---- dialogs (replacing prompt()/confirm()) ---------------------------------

/** Single-line text prompt. Resolves to the string, or null if cancelled. */
function promptDialog({ title, label, value = "", placeholder = "" }) {
  return new Promise((res) => {
    const inp = input("text", value, "dlg-text", placeholder);
    const body = field(label, inp);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; res(v); } };
    const close = savebar.openModal({
      title,
      body,
      actions: [
        { label: "Cancel", cls: "btn", onClick: (c) => { c(); done(null); } },
        { label: "Save", cls: "btn primary", onClick: (c) => { c(); done(inp.value); } },
      ],
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); close(); done(inp.value); }
    });
    // The modal focuses its last action by default; a text prompt wants the field.
    requestAnimationFrame(() => { inp.focus(); inp.select(); });
  });
}

/** Choose one of a list. Resolves to the chosen `value`, or null if cancelled. */
function pickDialog({ title, options }) {
  return new Promise((res) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; res(v); } };
    const list = document.createElement("div");
    list.className = "list";
    const close = savebar.openModal({
      title,
      body: list,
      actions: [{ label: "Cancel", cls: "btn", onClick: (c) => { c(); done(null); } }],
    });
    for (const o of options) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "list-row pick-row";
      row.disabled = !!o.disabled;
      const main = document.createElement("div");
      main.className = "list-row-main";
      const t = document.createElement("div");
      t.className = "list-row-title";
      t.textContent = o.label;
      main.appendChild(t);
      if (o.hint || o.disabled) {
        const m = document.createElement("div");
        m.className = "list-row-meta";
        m.textContent = o.disabled ? "current page" : o.hint;
        main.appendChild(m);
      }
      row.appendChild(main);
      row.onclick = () => { close(); done(o.value); };
      list.appendChild(row);
    }
    requestAnimationFrame(() => list.querySelector("button:not([disabled])")?.focus());
  });
}

// ---- form element helpers ---------------------------------------------------

let _fieldSeq = 0;
function field(label, control) {
  const d = document.createElement("div"); d.className = "field";
  if (label) {
    const l = document.createElement("label");
    l.textContent = label;
    const id = control.id || (control.dataset?.name ? `f-${control.dataset.name}` : `f-${++_fieldSeq}`);
    control.id = id;
    l.htmlFor = id;
    d.appendChild(l);
  }
  d.appendChild(control); return d;
}
function sectionTitle(t) { const d = document.createElement("div"); d.className = "section-title"; d.textContent = t; return d; }
/** A designed nothing-here state. An empty list used to render as blank space. */
function emptyState(title, body, action) {
  const d = document.createElement("div"); d.className = "empty";
  const t = document.createElement("div"); t.className = "empty-title"; t.textContent = title;
  d.appendChild(t);
  if (body) { const b = document.createElement("div"); b.className = "empty-body"; b.textContent = body; d.appendChild(b); }
  if (action) d.appendChild(action);
  return d;
}
function noteEl(t) { const d = document.createElement("div"); d.className = "note"; d.textContent = t; return d; }
function input(type, value, name, placeholder) {
  const i = document.createElement("input"); i.type = type; i.value = value ?? ""; i.dataset.name = name;
  if (placeholder) i.placeholder = placeholder; return i;
}
function textarea(value, name) { const t = document.createElement("textarea"); t.value = value ?? ""; t.dataset.name = name; return t; }
function select(options, value, onchange, name) {
  const s = document.createElement("select"); if (name) s.dataset.name = name;
  for (const o of options) {
    // options may be plain strings or { value, label } pairs
    const val = typeof o === "object" ? o.value : o;
    const txt = typeof o === "object" ? o.label : o;
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = txt; if (val === value) opt.selected = true;
    s.appendChild(opt);
  }
  if (onchange) s.onchange = () => onchange(s.value);
  return s;
}
function boolField(label, checked, name) {
  // Renders as a switch, but the control underneath is still a plain checkbox
  // carrying data-name — gather() reads `.checked` and neither knows nor cares.
  const d = document.createElement("div"); d.className = "field";
  const l = document.createElement("label"); l.className = "switch-row";
  const span = document.createElement("span"); span.className = "switch-label"; span.textContent = label;
  const sw = document.createElement("span"); sw.className = "switch";
  const c = document.createElement("input"); c.type = "checkbox"; c.checked = checked; c.dataset.name = name; c.id = `f-${name}`;
  sw.appendChild(c);
  l.append(span, sw); d.appendChild(l); return d;
}
function button(text, cls, fn) { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = text; b.onclick = fn; return b; }

// ---- shared schedule fields (page + widget) ---------------------------------

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function scheduleWindowsOf(s) {
  if (Array.isArray(s?.windows) && s.windows.length) return s.windows.map((w) => ({
    start: w.start || null, end: w.end || null, days: [...(w.days || [])],
  }));
  if (s?.start || s?.end || (s?.days && s.days.length)) {
    return [{ start: s.start || null, end: s.end || null, days: [...(s.days || [])] }];
  }
  return [{ start: null, end: null, days: [] }];
}

function dayPicker(days, name) {
  const dayWrap = document.createElement("div");
  dayWrap.className = "day-picker";
  dayWrap.dataset.name = name;
  DAY_LABELS.forEach((label, d) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day-chip" + ((days || []).includes(d) ? " on" : "");
    b.textContent = label;
    b.dataset.day = d;
    b.onclick = () => b.classList.toggle("on");
    dayWrap.appendChild(b);
  });
  return dayWrap;
}

function appendScheduleFields(editor, schedule, prefix) {
  const s = schedule || {};
  let windows = scheduleWindowsOf(s);

  editor.appendChild(boolField("Enable schedule", s.enabled === true, `${prefix}-enabled`));
  editor.appendChild(field("Timezone (IANA, blank = this device)", input("text", s.timeZone || "", `${prefix}-tz`, "America/Phoenix")));
  editor.appendChild(field("Date from (YYYY-MM-DD, optional)", input("date", s.dateFrom || "", `${prefix}-from`)));
  editor.appendChild(field("Date to (YYYY-MM-DD, optional)", input("date", s.dateTo || "", `${prefix}-to`)));
  editor.appendChild(noteEl("Multiple windows are OR’d (any matching window shows the page/widget). A window may wrap past midnight."));

  const host = document.createElement("div");
  host.className = "schedule-windows";
  host.dataset.name = `${prefix}-windows`;
  editor.appendChild(host);

  const redraw = () => {
    host.replaceChildren();
    windows.forEach((w, i) => {
      const card = document.createElement("div");
      card.className = "schedule-window-card";
      card.dataset.windowIndex = i;
      const head = document.createElement("div");
      head.className = "schedule-window-head";
      head.appendChild(Object.assign(document.createElement("strong"), { textContent: `Window ${i + 1}` }));
      if (windows.length > 1) {
        head.appendChild(button("Remove", "btn small danger", () => {
          windows = gatherScheduleWindows(host, prefix);
          windows.splice(i, 1);
          if (!windows.length) windows = [{ start: null, end: null, days: [] }];
          redraw();
        }));
      }
      card.appendChild(head);
      card.appendChild(field("Start (HH:MM)", input("time", w.start || "", `${prefix}-w-${i}-start`)));
      card.appendChild(field("End (HH:MM)", input("time", w.end || "", `${prefix}-w-${i}-end`)));
      card.appendChild(field("Days (none selected = every day)", dayPicker(w.days, `${prefix}-w-${i}-days`)));
      host.appendChild(card);
    });
  };
  redraw();
  editor.appendChild(button("+ Add window", "btn small", () => {
    windows = gatherScheduleWindows(host, prefix);
    windows.push({ start: null, end: null, days: [] });
    redraw();
  }));
}

function gatherScheduleWindows(host, prefix) {
  if (!host) return [];
  const out = [];
  host.querySelectorAll(".schedule-window-card").forEach((card, i) => {
    const start = card.querySelector(`[data-name="${prefix}-w-${i}-start"]`)?.value || null;
    const end = card.querySelector(`[data-name="${prefix}-w-${i}-end"]`)?.value || null;
    const dayWrap = card.querySelector(`[data-name="${prefix}-w-${i}-days"]`);
    const days = dayWrap
      ? [...dayWrap.querySelectorAll(".day-chip.on")].map((b) => Number(b.dataset.day))
      : [];
    out.push({ start, end, days });
  });
  return out;
}

function gatherSchedule(editor, prefix) {
  const enabled = editor.querySelector(`[data-name="${prefix}-enabled"]`)?.checked === true;
  const timeZone = editor.querySelector(`[data-name="${prefix}-tz"]`)?.value?.trim() || null;
  const dateFrom = editor.querySelector(`[data-name="${prefix}-from"]`)?.value || null;
  const dateTo = editor.querySelector(`[data-name="${prefix}-to"]`)?.value || null;
  const host = editor.querySelector(`[data-name="${prefix}-windows"]`);
  const windows = gatherScheduleWindows(host, prefix);
  const hasBounds = windows.some((w) => w.start || w.end || w.days.length)
    || timeZone || dateFrom || dateTo;
  if (!enabled && !hasBounds) return null;

  // Keep legacy single-window shape when there's only one simple window.
  if (windows.length <= 1 && !timeZone && !dateFrom && !dateTo) {
    const w = windows[0] || { start: null, end: null, days: [] };
    return { enabled, start: w.start, end: w.end, days: w.days, windows: [], timeZone: null, dateFrom: null, dateTo: null };
  }
  return {
    enabled,
    start: null,
    end: null,
    days: [],
    windows,
    timeZone,
    dateFrom,
    dateTo,
  };
}

// ---- slideshow widget slides editor ----------------------------------------

function slideTypeOptions() {
  return registry.types().filter((t) => t !== "slideshow");
}

function appendVariantsFields(editor, widget) {
  if (!Array.isArray(widget.variants)) widget.variants = [];
  const host = document.createElement("div");
  host.className = "variant-list";
  host.dataset.name = "variants";
  editor.appendChild(host);

  const redraw = () => {
    host.replaceChildren();
    widget.variants.forEach((v, i) => {
      const card = document.createElement("div");
      card.className = "variant-card";
      card.dataset.variantIndex = i;
      const head = document.createElement("div");
      head.className = "variant-card-head";
      head.appendChild(Object.assign(document.createElement("strong"), {
        textContent: i === 0 ? `Variant ${i + 1} (default)` : `Variant ${i + 1}`,
      }));
      head.appendChild(button("Remove", "btn small danger", () => {
        widget.variants = gatherVariants(editor);
        widget.variants.splice(i, 1);
        redraw();
      }));
      card.appendChild(head);
      card.appendChild(field("Label", input("text", v.label || "", `var-${i}-label`, "night")));
      const ta = textarea(
        typeof v.overrides === "object" && v.overrides
          ? JSON.stringify(v.overrides, null, 2)
          : "{}",
        `var-${i}-overrides`,
      );
      ta.rows = 3;
      card.appendChild(field("Overrides (JSON object)", ta));
      host.appendChild(card);
    });
  };
  redraw();
  editor.appendChild(button("+ Add variant", "btn small", () => {
    widget.variants = gatherVariants(editor);
    widget.variants.push({ label: "", overrides: {} });
    redraw();
  }));
}

function gatherVariants(editor, { strict = false } = {}) {
  const host = editor.querySelector('[data-name="variants"]');
  if (!host) return [];
  const out = [];
  host.querySelectorAll(".variant-card").forEach((card, i) => {
    const label = (card.querySelector(`[data-name="var-${i}-label"]`)?.value || "").trim();
    const raw = card.querySelector(`[data-name="var-${i}-overrides"]`)?.value || "{}";
    let overrides = {};
    try {
      const parsed = JSON.parse(raw || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) overrides = parsed;
      else throw new Error("not an object");
    } catch (err) {
      if (strict) throw new Error(`Variant ${i + 1}: overrides must be a JSON object`);
      overrides = {};
    }
    if (!label && !Object.keys(overrides).length) return;
    out.push({ label: label || `variant-${i + 1}`, overrides });
  });
  return out;
}

// Slides carry a stable id so the server can match per-slide secrets across a
// reorder (see redact.preserve_secrets). Mint one for any slide missing it.
const slideId = () => `slide-${Math.random().toString(36).slice(2, 10)}`;

function appendSlideshowFields(editor, widget) {
  const cfg = widget.slideshow || { enabled: true, durationSeconds: 30, slides: [] };
  widget.slideshow = cfg;
  if (!Array.isArray(cfg.slides)) cfg.slides = [];
  for (const s of cfg.slides) if (!s.id) s.id = slideId();

  editor.appendChild(boolField("Enable slideshow", cfg.enabled !== false, "ss-enabled"));
  editor.appendChild(field("Seconds per slide", input("number", cfg.durationSeconds ?? 30, "ss-duration")));
  const host = document.createElement("div");
  host.dataset.name = "ss-slides";
  editor.appendChild(host);

  const redraw = () => {
    host.replaceChildren();
    cfg.slides.forEach((slide, i) => {
      const card = document.createElement("div");
      card.className = "slide-card";
      card.dataset.slideIndex = i;
      card.dataset.slideId = slide.id || "";
      const head = document.createElement("div");
      head.className = "slide-card-head";
      head.appendChild(Object.assign(document.createElement("strong"), { textContent: `Slide ${i + 1}` }));
      const tools = document.createElement("div");
      tools.style.display = "flex";
      tools.style.gap = "4px";
      tools.append(
        button("↑", "btn small", () => {
          if (i <= 0) return;
          const cur = gatherSlideshow(editor, widget);
          const arr = cur.slides;
          [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
          widget.slideshow = cur;
          appendSlideshowFieldsRebuild(editor, widget);
        }),
        button("↓", "btn small", () => {
          const cur = gatherSlideshow(editor, widget);
          const arr = cur.slides;
          if (i >= arr.length - 1) return;
          [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
          widget.slideshow = cur;
          appendSlideshowFieldsRebuild(editor, widget);
        }),
        button("Remove", "btn small danger", () => {
          const cur = gatherSlideshow(editor, widget);
          cur.slides.splice(i, 1);
          widget.slideshow = cur;
          appendSlideshowFieldsRebuild(editor, widget);
        }),
      );
      head.appendChild(tools);
      card.appendChild(head);

      const types = slideTypeOptions();
      const typeSel = select(types, slide.type || types[0], (v) => {
        const cur = gatherSlideshow(editor, widget);
        cur.slides[i] = { id: cur.slides[i]?.id || slideId(), type: v, title: cur.slides[i]?.title || "", settings: {} };
        widget.slideshow = cur;
        appendSlideshowFieldsRebuild(editor, widget);
      }, `ss-${i}-type`);
      card.appendChild(field("Type", typeSel));
      card.appendChild(field("Title", input("text", slide.title || "", `ss-${i}-title`)));

      const plugin = registry.get(slide.type || types[0]);
      const fields = (plugin?.schema?.fields || []).filter((f) => f.type !== "note");
      const fakeWidget = { settings: slide.settings || {} };
      for (const f of fields) {
        const node = renderField(f, fakeWidget);
        // Remap settings field names into per-slide namespace
        node.querySelectorAll("[data-name]").forEach((el) => {
          const n = el.dataset.name;
          if (n.startsWith("set-")) el.dataset.name = `ss-${i}-${n}`;
        });
        card.appendChild(node);
      }
      host.appendChild(card);
    });
  };
  redraw();
  editor._redrawSlides = redraw;

  editor.appendChild(button("+ Add slide", "btn", async () => {
    // Same picker as adding a widget, minus slideshow (a slideshow can't
    // contain a slideshow).
    const type = await pickWidgetType({ title: "Add slide", exclude: ["slideshow"] });
    if (!type) return;
    const cur = gatherSlideshow(editor, widget);
    cur.slides.push({ id: slideId(), type, title: "", settings: defaultSettings(type) });
    widget.slideshow = cur;
    appendSlideshowFieldsRebuild(editor, widget);
  }));
}

function appendSlideshowFieldsRebuild(editor, widget) {
  // Re-render the whole form so slide field names stay consistent with gather.
  // Preserve the in-memory slides list (reorder/remove already applied) — a
  // fresh gatherSlideshow would read the pre-mutation DOM order.
  const slides = widget.slideshow;
  const w = gather(editor, widget);
  w.slideshow = slides;
  renderForm(editor, w);
}

function gatherSlideshow(editor, widget) {
  const enabled = editor.querySelector('[data-name="ss-enabled"]')?.checked !== false;
  const duration = Math.max(2, Math.round(Number(editor.querySelector('[data-name="ss-duration"]')?.value) || 30));
  const host = editor.querySelector('[data-name="ss-slides"]');
  const slides = [];
  if (host) {
    host.querySelectorAll(".slide-card").forEach((card, i) => {
      const type = card.querySelector(`[data-name="ss-${i}-type"]`)?.value || "text";
      const title = card.querySelector(`[data-name="ss-${i}-title"]`)?.value || "";
      const settings = {};
      const plugin = registry.get(type);
      for (const f of plugin?.schema?.fields || []) {
        if (f.type === "note" || f.type === "stock-picker") continue;
        const node = card.querySelector(`[data-name="ss-${i}-set-${f.key}"]`);
        if (!node) continue;
        if (f.type === "boolean") settings[f.key] = node.checked;
        else if (f.type === "password") { if (node.value) settings[f.key] = node.value; }
        else if (f.type === "number") settings[f.key] = node.value === "" ? null : Number(node.value);
        else settings[f.key] = node.value;
      }
      // Blank password fields are left blank on purpose: the server matches on
      // slide id and carries the previous value over (redact.preserve_secrets).
      slides.push({ id: card.dataset.slideId || slideId(), type, title, settings });
    });
  }
  return { enabled, durationSeconds: duration, slides };
}

// ---- url field with quick-fill presets (for embeddable live sites) ----------

function urlPresets(f, val) {
  const wrap = document.createElement("div");
  const inp = input("text", val, "set-" + f.key, f.placeholder);
  const sel = document.createElement("select");
  sel.style.marginTop = "6px";
  const ph = document.createElement("option"); ph.value = ""; ph.textContent = "Quick-fill a known embeddable site…";
  sel.appendChild(ph);
  for (const p of f.presets || []) {
    const o = document.createElement("option"); o.value = p.url; o.textContent = p.label; sel.appendChild(o);
  }
  sel.onchange = () => { if (sel.value) { inp.value = sel.value; sel.value = ""; } };
  wrap.append(inp, sel);
  return wrap;
}

// ---- embed snippet field: preset picker + textarea + live preview -----------

function embedPresets(f, val) {
  const wrap = document.createElement("div");
  const ta = textarea(val, "set-" + f.key);       // gather() reads set-<key>
  ta.className = "mono embed-code";
  ta.placeholder = "Paste a TradingView (or any <div>+<script>) snippet…";

  const sel = document.createElement("select");
  sel.className = "embed-preset-select";
  const ph = document.createElement("option"); ph.value = ""; ph.textContent = "Quick-fill a preset…";
  sel.appendChild(ph);
  (f.presets || []).forEach((p, i) => {
    const o = document.createElement("option"); o.value = String(i); o.textContent = p.label; sel.appendChild(o);
  });

  const preview = document.createElement("iframe");
  preview.className = "embed-preview";
  preview.title = "Live preview of the pasted snippet";
  preview.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms");
  const previewLabel = noteEl("Live preview");
  previewLabel.className = "note embed-preview-label";

  let t;
  const renderPreview = () => { clearTimeout(t); t = setTimeout(() => { preview.srcdoc = buildEmbedDoc(ta.value); }, 400); };
  sel.onchange = () => {
    const p = (f.presets || [])[Number(sel.value)];
    if (p) { ta.value = p.code; renderPreview(); }
    sel.value = "";
  };
  ta.addEventListener("input", renderPreview);
  renderPreview();

  wrap.append(ta, sel, previewLabel, preview);
  return wrap;
}

// ---- stock picker (the async-search field type) -----------------------------

function stockPicker(widget) {
  const wrap = document.createElement("div");
  widget.settings = widget.settings || {};
  let symbols = Array.isArray(widget.settings.symbols) ? [...widget.settings.symbols] : [];
  const chips = document.createElement("div"); chips.className = "chips";
  const search = input("text", "", "stock-search", "Search ticker or company…");
  const results = document.createElement("div"); results.className = "search-results";

  function sync() { widget.settings.symbols = symbols; }
  function drawChips() {
    chips.replaceChildren();
    symbols.forEach((sym, i) => {
      const c = document.createElement("span"); c.className = "chip"; c.textContent = sym;
      const x = document.createElement("button"); x.textContent = "×";
      x.onclick = () => { symbols.splice(i, 1); sync(); drawChips(); };
      c.appendChild(x); chips.appendChild(c);
    });
  }
  let timer;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    const q = search.value.trim();
    if (!q) { results.replaceChildren(); return; }
    timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/data/stocks/search?q=" + encodeURIComponent(q));
        const d = await res.json();
        results.replaceChildren();
        if (d.needsKey) { results.innerHTML = `<div>Set ${d.env} to search</div>`; return; }
        for (const r of d.results || []) {
          const item = document.createElement("div");
          item.textContent = `${r.symbol} — ${r.description || ""}`;
          item.onclick = () => {
            if (!symbols.includes(r.symbol)) { symbols.push(r.symbol); sync(); drawChips(); }
            search.value = ""; results.replaceChildren();
          };
          results.appendChild(item);
        }
      } catch { results.innerHTML = "<div>search failed</div>"; }
    }, 250);
  });
  drawChips(); sync();
  wrap.append(chips, search, results);
  return wrap;
}

// ---- API keys ---------------------------------------------------------------

async function openKeys() {
  state.editingId = null;
  const editor = openPanel("API keys", { scope: "immediate", section: "keys" });
  editor.appendChild(noteEl("Stored on the server (data/secrets.json), never sent back to the browser. Widgets work without keys but show a “needs key” state."));

  let status = {};
  try { status = await (await fetch("/api/secrets")).json(); }
  catch { toast("Could not load key status", "err"); return; }

  const inputs = {};
  for (const [key, info] of Object.entries(status)) {
    const f = document.createElement("div"); f.className = "field";
    const label = document.createElement("label");
    label.textContent = `${info.label} — ${key}` + (info.set ? `  ✓ set (${info.source})` : "  (not set)");
    f.appendChild(label);
    const inp = document.createElement("input"); inp.type = "password";
    inp.placeholder = info.editable ? (info.set ? "•••••• (leave blank to keep)" : "Paste key…") : "Set via environment variable";
    inp.disabled = !info.editable;
    f.appendChild(inp); inputs[key] = inp; editor.appendChild(f);
  }

  const actions = document.createElement("div"); actions.className = "editor-actions";
  actions.append(
    button("Cancel", "btn", () => showDefault()),
    button("Save keys", "btn primary", async () => {
      const values = {};
      for (const [key, inp] of Object.entries(inputs)) if (!inp.disabled && inp.value) values[key] = inp.value;
      if (!Object.keys(values).length) { toast("Nothing to save", ""); return; }
      try {
        const res = await fetch("/api/secrets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ values }),
        });
        if (!res.ok) { toast("Save failed: " + res.status, "err"); return; }
        toast("Keys saved · dashboards refreshing", "ok");
        showDefault();
      } catch (e) { toast("Save failed: " + e.message, "err"); }
    }),
  );
  editor.appendChild(actions);
}

// ---- backups / restore ------------------------------------------------------

async function openBackups() {
  state.editingId = null;
  const editor = openPanel("Backups", { scope: "immediate", section: "backups" });
  editor.appendChild(noteEl("Every save writes a timestamped backup (newest first). Restoring makes that version current — your present config stays in history, so a restore is itself undoable."));

  let backups = [];
  try { backups = (await (await fetch("/api/backups")).json()).backups || []; }
  catch { toast("Could not load backups", "err"); return; }

  if (!backups.length) { editor.appendChild(noteEl("No backups yet.")); }
  const list = document.createElement("div"); list.className = "backup-list";
  for (const b of backups) {
    const row = document.createElement("div"); row.className = "backup-row";
    const when = new Date(b.savedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const isCurrent = b.version === state.config.version;
    row.innerHTML = `<div class="backup-info"><div class="backup-when"></div><div class="backup-meta"></div></div>`;
    row.querySelector(".backup-when").textContent = when;
    row.querySelector(".backup-meta").textContent = `v${b.version} · ${(b.size / 1024).toFixed(1)} KB` + (isCurrent ? " · current" : "");
    if (isCurrent) row.classList.add("current");
    const btn = document.createElement("button");
    btn.className = "btn small primary"; btn.textContent = "Restore";
    btn.disabled = isCurrent;
    btn.onclick = () => restoreBackup(b);
    row.appendChild(btn);
    list.appendChild(row);
  }
  editor.appendChild(list);
  const actions = document.createElement("div"); actions.className = "editor-actions";
  actions.append(button("Close", "btn", () => showDefault()));
  editor.appendChild(actions);
}

// ---- page schedule (time-window visibility for the whole page) ---------------
// Same Schedule shape widgets use (days 0=Mon..6=Sun, HH:MM window, may wrap
// past midnight). Displays skip the page outside the window.

const CONDITION_TYPES = [
  { value: "octoprint", label: "OctoPrint (printer state)" },
  { value: "weather-alert", label: "Weather alert (NWS)" },
  { value: "youtube-live", label: "YouTube live" },
  { value: "calendar-soon", label: "Calendar event soon" },
];

function defaultConditionPriority(type, matchStates) {
  if (type === "weather-alert") return 90;
  if (type === "youtube-live") return 40;
  if (type === "calendar-soon") return 30;
  if (type === "octoprint") {
    const states = matchStates || [];
    if (states.includes("error") && !states.includes("printing") && !states.includes("paused")) return 80;
    if (states.includes("error")) return 80;
    return 50;
  }
  return 50;
}

function widgetsOfType(type) {
  const out = [];
  for (const p of pages()) {
    for (const w of p.widgets || []) {
      if (w.type === type) out.push({ id: w.id, label: `${w.title || w.id} (${p.name})` });
    }
  }
  return out;
}

function appendConditionFields(editor, condition) {
  const c = condition || {};
  const host = document.createElement("div");
  host.dataset.name = "pc-host";
  editor.appendChild(host);

  const redraw = (next) => {
    const cur = { ...c, ...next };
    host.replaceChildren();
    host.appendChild(boolField("Enable condition", cur.enabled === true, "pc-enabled"));
    host.appendChild(noteEl(
      "Time window AND condition must both match. Soft-join adds the page to the slideshow while true; force-override jumps to it immediately (highest priority wins)."
    ));

    const typeSel = select(CONDITION_TYPES, cur.type || "octoprint", (v) => {
      const states = gatherMatchStates(host);
      redraw({
        enabled: host.querySelector('[data-name="pc-enabled"]')?.checked === true,
        type: v,
        mode: host.querySelector('[data-name="pc-mode"]')?.value || cur.mode || "soft-join",
        priority: defaultConditionPriority(v, states),
        sourceWidgetId: "",
        matchStates: v === "octoprint" ? (states.length ? states : ["printing"]) : cur.matchStates,
        minSeverity: host.querySelector('[data-name="pc-minSeverity"]')?.value || cur.minSeverity || "",
        leadMinutes: Number(host.querySelector('[data-name="pc-leadMinutes"]')?.value) || cur.leadMinutes || 30,
        pollSeconds: host.querySelector('[data-name="pc-pollSeconds"]')?.value ?? cur.pollSeconds,
      });
    }, "pc-type");
    host.appendChild(field("When", typeSel));

    host.appendChild(field("Mode", select(
      [
        { value: "soft-join", label: "Soft-join (rotate with other pages)" },
        { value: "force-override", label: "Force-override (jump and hold)" },
      ],
      cur.mode || "soft-join",
      null,
      "pc-mode",
    )));

    const pri = cur.priority ?? defaultConditionPriority(cur.type || "octoprint", cur.matchStates);
    host.appendChild(field("Priority (0–100, higher wins)", input("number", pri, "pc-priority")));

    const type = cur.type || "octoprint";
    if (type === "octoprint") {
      const src = widgetsOfType("octoprint");
      const opts = [{ value: "", label: src.length ? "— pick OctoPrint widget —" : "— add an OctoPrint widget first —" },
        ...src.map((w) => ({ value: w.id, label: w.label }))];
      host.appendChild(field("Source widget", select(opts, cur.sourceWidgetId || "", null, "pc-source")));
      const states = cur.matchStates?.length ? cur.matchStates : ["printing"];
      const wrap = document.createElement("div");
      wrap.className = "day-picker";
      wrap.dataset.name = "pc-matchStates";
      for (const s of ["printing", "paused", "error"]) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "day-chip" + (states.includes(s) ? " on" : "");
        b.textContent = s;
        b.dataset.state = s;
        b.onclick = () => {
          b.classList.toggle("on");
          const nextStates = gatherMatchStates(host);
          const priEl = host.querySelector('[data-name="pc-priority"]');
          if (priEl && document.activeElement !== priEl) {
            priEl.value = String(defaultConditionPriority("octoprint", nextStates));
          }
        };
        wrap.appendChild(b);
      }
      host.appendChild(field("Match states", wrap));
    } else if (type === "weather-alert") {
      host.appendChild(field("Minimum severity", select(
        [
          { value: "", label: "Any" },
          { value: "info", label: "Info+" },
          { value: "warning", label: "Warning+" },
          { value: "danger", label: "Danger only" },
        ],
        cur.minSeverity || "",
        null,
        "pc-minSeverity",
      )));
    } else if (type === "youtube-live") {
      const src = widgetsOfType("youtube-live");
      const opts = [{ value: "", label: src.length ? "— pick YouTube widget —" : "— add a YouTube widget first —" },
        ...src.map((w) => ({ value: w.id, label: w.label }))];
      host.appendChild(field("Source widget", select(opts, cur.sourceWidgetId || "", null, "pc-source")));
      host.appendChild(noteEl("The YouTube widget must use Channel ID live mode (not a fixed video URL)."));
    } else if (type === "calendar-soon") {
      const src = widgetsOfType("ical");
      const opts = [{ value: "", label: src.length ? "— pick Calendar widget —" : "— add an iCal widget first —" },
        ...src.map((w) => ({ value: w.id, label: w.label }))];
      host.appendChild(field("Source widget", select(opts, cur.sourceWidgetId || "", null, "pc-source")));
      host.appendChild(field("Lead minutes", input("number", cur.leadMinutes ?? 30, "pc-leadMinutes")));
    }

    host.appendChild(field(
      "Re-check every (seconds, blank = default 5)",
      input("number", cur.pollSeconds ?? "", "pc-pollSeconds"),
    ));
  };

  redraw({});
}

function gatherMatchStates(root) {
  const wrap = root.querySelector('[data-name="pc-matchStates"]');
  if (!wrap) return [];
  return [...wrap.querySelectorAll(".day-chip.on")].map((b) => b.dataset.state);
}

function gatherCondition(editor) {
  const host = editor.querySelector('[data-name="pc-host"]') || editor;
  const enabled = host.querySelector('[data-name="pc-enabled"]')?.checked === true;
  const type = host.querySelector('[data-name="pc-type"]')?.value || "octoprint";
  const mode = host.querySelector('[data-name="pc-mode"]')?.value || "soft-join";
  let priority = Math.round(Number(host.querySelector('[data-name="pc-priority"]')?.value));
  if (!Number.isFinite(priority)) priority = defaultConditionPriority(type, gatherMatchStates(host));
  priority = Math.max(0, Math.min(100, priority));
  const sourceWidgetId = host.querySelector('[data-name="pc-source"]')?.value || null;
  const matchStates = gatherMatchStates(host);
  const minRaw = host.querySelector('[data-name="pc-minSeverity"]')?.value || "";
  const minSeverity = minRaw || null;
  let leadMinutes = Math.round(Number(host.querySelector('[data-name="pc-leadMinutes"]')?.value));
  if (!Number.isFinite(leadMinutes) || leadMinutes < 1) leadMinutes = 30;
  leadMinutes = Math.min(10080, leadMinutes);
  const pollRaw = host.querySelector('[data-name="pc-pollSeconds"]')?.value;
  let pollSeconds = null;
  if (pollRaw !== "" && pollRaw != null) {
    pollSeconds = Math.round(Number(pollRaw));
    if (!Number.isFinite(pollSeconds) || pollSeconds < 2) pollSeconds = null;
    else pollSeconds = Math.min(300, pollSeconds);
  }
  if (!enabled) return null;
  const out = { enabled, type, mode, priority, pollSeconds };
  if (type === "octoprint") {
    out.sourceWidgetId = sourceWidgetId;
    out.matchStates = matchStates.length ? matchStates : ["printing"];
  } else if (type === "weather-alert") {
    out.minSeverity = minSeverity;
  } else if (type === "youtube-live") {
    out.sourceWidgetId = sourceWidgetId;
  } else if (type === "calendar-soon") {
    out.sourceWidgetId = sourceWidgetId;
    out.leadMinutes = leadMinutes;
  }
  return out;
}

function openPageSchedule(i) {
  const page = pages()[i];
  if (!page) return;
  openPageSettings(i);
}

/**
 * The inspector's default surface: everything about the current page in one
 * place. Replaces the rename prompt() and the separate schedule panel.
 */
function openPageSettings(index) {
  const i = index ?? state.activePage;
  const page = pages()[i];
  if (!page) return;
  state.editingId = null;
  const editor = openPanel(page.name || "Page", { section: "pages" });

  editor.appendChild(field("Page name", input("text", page.name || "", "pg-name")));
  const dur = input("number", page.durationSeconds ?? "", "pg-duration");
  dur.placeholder = String(rotation().defaultDurationSeconds ?? 30);
  editor.appendChild(field("Seconds in rotation", dur));
  editor.appendChild(noteEl("Blank = use the rotation default."));

  editor.appendChild(sectionTitle("Time window"));
  editor.appendChild(noteEl("Show this page only during a time window. Outside it, rotation skips the page (and a display assigned only this page falls back to the others). The window may wrap past midnight, e.g. 21:00 → 06:00."));
  appendScheduleFields(editor, page.schedule || {}, "ps");

  editor.appendChild(sectionTitle("Live condition"));
  appendConditionFields(editor, page.condition || {});

  const actions = document.createElement("div"); actions.className = "editor-actions";
  actions.append(
    button("Revert", "btn", () => openPageSettings(i)),
    button("Apply", "btn primary", () => {
      const name = editor.querySelector('[data-name="pg-name"]').value.trim();
      page.name = name || "Page";
      const raw = String(editor.querySelector('[data-name="pg-duration"]').value ?? "").trim();
      page.durationSeconds = raw === "" ? null : Math.max(2, Number(raw) || 2);
      page.schedule = gatherSchedule(editor, "ps");
      page.condition = gatherCondition(editor);
      save(`changed page “${page.name}”`);
      openPageSettings(i);
    }),
  );
  editor.appendChild(actions);
}

// ---- system (immediate-effect operations) -----------------------------------

function openSystem() {
  state.editingId = null;
  const editor = openPanel("System", { scope: "immediate", section: "system" });
  editor.appendChild(noteEl("These act on the running dashboard right away — they are not staged and Undo does not reach them."));

  const act = (label, cls, note, fn) => {
    editor.appendChild(sectionTitle(label));
    editor.appendChild(noteEl(note));
    const b = button(label, "btn " + cls, fn);
    b.dataset.action = label;
    editor.appendChild(b);
  };

  act("Test alert", "small", "Pushes a sample alert banner to every display, to check they're listening.", async () => {
    try { await api.testAlert(); toast("Test alert sent to all displays", "ok"); }
    catch (e) { toast("Test alert failed: " + e.message, "err"); }
  });

  act("Force refresh", "small", "Tells every display to re-fetch and re-render now.", async () => {
    try { await api.forceRefresh(); toast("Dashboards refreshing", "ok"); }
    catch (e) { toast("Refresh failed: " + e.message, "err"); }
  });

  act("Clear cache", "small", "Drops every cached provider response, so the next render fetches fresh data.", async () => {
    try { const d = await api.clearCache(); toast(`Cache cleared (${d.cleared})`, "ok"); }
    catch (e) { toast("Clear cache failed: " + e.message, "err"); }
  });

  act("Update", "small danger", "Pulls the latest commit on the current branch and restarts if anything moved.", async () => {
    const ok = await savebar.confirmDialog({
      title: "Update the dashboard?",
      message: "This pulls the latest commit on the current branch and restarts the dashboard if anything moved. Displays will blink.",
      confirmLabel: "Pull and restart",
      danger: true,
    });
    if (!ok) return;
    try {
      const d = await api.systemUpdate();
      toast(d.restarting
        ? `Updated ${d.branch} ${d.previousSha} → ${d.sha}; restarting`
        : `Already up to date (${d.branch} ${d.sha})`, "ok");
    } catch (e) { toast("Update failed: " + e.message, "err"); }
  });
}

// ---- layout & grid (resize granularity) -------------------------------------
// columns / rowHeightPx / gapPx are the grid widgets snap to on the canvas, so
// they ARE the resize granularity. This grid is shared by every display. Raising
// the column count would normally reflow every widget (they keep their numbers
// but now span a smaller fraction), so we offer a proportional rescale that
// keeps the current look while making the steps finer.

function openLayout() {
  state.editingId = null;
  const editor = openPanel("Appearance & grid", { section: "appearance" });
  const s = state.config.settings || (state.config.settings = {});
  const theme = s.theme || (s.theme = { mode: "dark", accent: "#4aa3ff" });
  const oldCols = s.columns || 12, oldRow = s.rowHeightPx || 90, oldGap = s.gapPx ?? 12;

  const h = document.createElement("h2"); h.textContent = "Layout & appearance"; h.style.margin = "0 0 6px";
  editor.appendChild(h);

  const loc = s.location || (s.location = { lat: null, lon: null, city: "", region: "" });

  editor.appendChild(sectionTitle("Dashboard"));
  editor.appendChild(field("Title", input("text", s.title || "Pi Dashboard", "lay-title")));
  editor.appendChild(field("Theme", select(
    [
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
      { value: "auto", label: "Auto (follow system)" },
    ],
    theme.mode || "dark",
    null,
    "lay-theme",
  )));
  editor.appendChild(field("Accent color", input("color", theme.accent || "#4aa3ff", "lay-accent")));

  editor.appendChild(sectionTitle("Home location"));
  editor.appendChild(noteEl("Used for NWS weather alerts and as the default for weather / air-quality widgets (unless a widget sets its own lat/lon). Leave lat+lon blank to use IP geolocation (falls back to Phoenix, AZ)."));
  editor.appendChild(field("Latitude", input("number", loc.lat ?? "", "lay-lat", "e.g. 33.45")));
  editor.appendChild(field("Longitude", input("number", loc.lon ?? "", "lay-lon", "e.g. -112.07")));
  editor.appendChild(field("City (label)", input("text", loc.city || "", "lay-city")));
  editor.appendChild(field("Region (label)", input("text", loc.region || "", "lay-region")));

  editor.appendChild(sectionTitle("Grid"));
  editor.appendChild(noteEl("Widgets snap to this grid when you drag-resize on the canvas — so it sets how finely you can size them. More columns = smaller width steps; a shorter row height = smaller height steps. This grid is shared by every display."));

  editor.appendChild(field("Columns (1–48)", input("number", oldCols, "lay-cols")));
  editor.appendChild(field("Row height px (≥20)", input("number", oldRow, "lay-row")));
  editor.appendChild(field("Gap px (≥0)", input("number", oldGap, "lay-gap")));

  const stepNote = noteEl("");
  const colsEl = editor.querySelector('[data-name="lay-cols"]');
  const rowEl = editor.querySelector('[data-name="lay-row"]');
  const updateStep = () => {
    const c = Math.max(1, Math.round(Number(colsEl.value) || 12));
    const r = Math.max(20, Math.round(Number(rowEl.value) || 90));
    stepNote.textContent = `Resize step: width ≈ ${(100 / c).toFixed(1)}% of the screen · height = ${r}px per row.`;
  };
  editor.appendChild(stepNote); updateStep();
  colsEl.oninput = updateStep; rowEl.oninput = updateStep;

  editor.appendChild(boolField("Keep current look — rescale existing widgets to the new grid", true, "lay-rescale"));
  editor.appendChild(noteEl("With this on, changing the grid resizes every widget proportionally so the dashboard looks the same, just with finer steps. Off = widgets keep their exact numbers (a bigger grid makes them smaller)."));

  const actions = document.createElement("div"); actions.className = "editor-actions";
  actions.append(
    button("Cancel", "btn", () => showDefault()),
    button("Save", "btn primary", () => saveLayout(oldCols, oldRow)),
  );
  editor.appendChild(actions);
}

function saveLayout(oldCols, oldRow) {
  const editor = $("#editor");
  const s = state.config.settings || (state.config.settings = {});
  s.title = editor.querySelector('[data-name="lay-title"]')?.value?.trim() || "Pi Dashboard";
  s.theme = s.theme || {};
  s.theme.mode = editor.querySelector('[data-name="lay-theme"]')?.value || "dark";
  s.theme.accent = editor.querySelector('[data-name="lay-accent"]')?.value || "#4aa3ff";

  const latRaw = editor.querySelector('[data-name="lay-lat"]')?.value?.trim() ?? "";
  const lonRaw = editor.querySelector('[data-name="lay-lon"]')?.value?.trim() ?? "";
  const lat = latRaw === "" ? null : Number(latRaw);
  const lon = lonRaw === "" ? null : Number(lonRaw);
  if ((lat == null) !== (lon == null)) {
    toast("Set both latitude and longitude, or leave both blank for auto", "err");
    return;
  }
  if (lat != null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
    toast("Latitude must be between -90 and 90", "err");
    return;
  }
  if (lon != null && (!Number.isFinite(lon) || lon < -180 || lon > 180)) {
    toast("Longitude must be between -180 and 180", "err");
    return;
  }
  s.location = {
    lat,
    lon,
    city: editor.querySelector('[data-name="lay-city"]')?.value?.trim() || "",
    region: editor.querySelector('[data-name="lay-region"]')?.value?.trim() || "",
  };

  const newCols = clamp(Math.round(Number(editor.querySelector('[data-name="lay-cols"]').value) || 12), 1, 48);
  const newRow = Math.max(20, Math.round(Number(editor.querySelector('[data-name="lay-row"]').value) || 90));
  const newGap = Math.max(0, Math.round(Number(editor.querySelector('[data-name="lay-gap"]').value) || 0));
  const rescale = editor.querySelector('[data-name="lay-rescale"]').checked;

  if (rescale && (newCols !== oldCols || newRow !== oldRow)) {
    const rx = newCols / oldCols;   // width lever: keep w/columns constant
    const ry = oldRow / newRow;     // height lever: keep h*rowHeight constant
    for (const p of pages()) {
      for (const w of (p.widgets || [])) {
        if (!w.grid) continue;
        w.grid.w = clamp(Math.round((w.grid.w || 4) * rx), 1, newCols);
        w.grid.x = clamp(Math.round((w.grid.x || 0) * rx), 0, newCols - w.grid.w);
        w.grid.h = Math.max(1, Math.round((w.grid.h || 3) * ry));
        w.grid.y = Math.max(0, Math.round((w.grid.y || 0) * ry));
      }
    }
  }
  s.columns = newCols; s.rowHeightPx = newRow; s.gapPx = newGap;
  showDefault();
  save("changed layout & appearance");
}

// ---- displays (per-device scaling) ------------------------------------------
// Each screen stores its own uiScale/fontScale server-side (see
// server/shared/devices.py); editing here PUTs and pushes it live over SSE.

const UI_MIN = 0.5, UI_MAX = 2.0, UI_STEP = 0.05;
const FONT_MIN = 0.6, FONT_MAX = 1.8, FONT_STEP = 0.05;
const clampScale = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)) * 1000) / 1000;

// Generation token: overlapping openDisplays() calls (double-click Displays /
// Refresh while a fetch is in flight) used to append a second full list after
// the first request completed — every display appeared twice.
let displaysGen = 0;

async function openDisplays() {
  const gen = ++displaysGen;
  state.editingId = null;
  const editor = openPanel("Displays", { scope: "immediate", section: "displays" });
  editor.appendChild(noteEl("Every screen loads the same layout, but each keeps its own size overlay so small displays can shrink text and rows to fit. Changes apply live. A display appears here after it has loaded the dashboard once. Remove stale duplicates that no longer connect."));
  editor.appendChild(button("Refresh", "btn small", openDisplays));

  let devices = [];
  try {
    const res = await fetch("/api/devices");
    if (!res.ok) throw new Error(String(res.status));
    devices = (await res.json()).devices || [];
  } catch {
    if (gen !== displaysGen) return;
    toast("Could not load displays", "err");
    return;
  }
  if (gen !== displaysGen) return; // newer openDisplays won the race

  if (!devices.length) editor.appendChild(noteEl("No displays have connected yet."));
  const list = document.createElement("div"); list.className = "device-list";
  for (const d of devices) list.appendChild(deviceRow(d));
  editor.appendChild(list);

  const actions = document.createElement("div"); actions.className = "editor-actions";
  actions.append(button("Close", "btn", () => showDefault()));
  editor.appendChild(actions);
}

function deviceRow(d) {
  const row = document.createElement("div"); row.className = "device-row";
  const seen = d.lastSeen ? new Date(d.lastSeen * 1000) : null;
  const stale = seen ? (Date.now() - seen.getTime()) > 90_000 : true;

  const info = document.createElement("div"); info.className = "device-info";
  const name = document.createElement("input");
  name.type = "text";
  name.className = "device-name-input";
  name.value = d.name || `Display ${d.id.slice(0, 4)}`;
  name.title = "Click to rename";
  name.setAttribute("aria-label", "Display name");
  const meta = document.createElement("div"); meta.className = "device-meta";
  meta.textContent = [
    d.viewport || "unknown size",
    `id ${d.id.slice(0, 8)}`,
    seen ? (stale ? "last seen " + seen.toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "online") : "never seen",
  ].join(" · ");
  if (!stale) row.classList.add("online");
  info.append(name, meta);

  // Live-editable local copy; PUT (debounced) on each nudge.
  const cur = {
    uiScale: d.uiScale ?? 1,
    fontScale: d.fontScale ?? 1,
    pages: [...(d.pages || [])],
    name: name.value,
  };
  let putTimer = null;
  const push = () => {
    clearTimeout(putTimer);
    putTimer = setTimeout(() => {
      fetch(`/api/devices/${encodeURIComponent(d.id)}/prefs`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uiScale: cur.uiScale,
          fontScale: cur.fontScale,
          pages: cur.pages,
          name: cur.name,
        }),
      }).then((r) => { if (r.ok) toast("Display updated", "ok"); }).catch(() => toast("Update failed", "err"));
    }, 350);
  };
  name.onchange = () => {
    const next = name.value.trim() || `Display ${d.id.slice(0, 4)}`;
    name.value = next;
    cur.name = next;
    push();
  };

  const controls = document.createElement("div"); controls.className = "device-controls";
  controls.append(
    scaleStepper("Size", () => cur.uiScale, (v) => { cur.uiScale = clampScale(v, UI_MIN, UI_MAX); push(); }, UI_STEP),
    scaleStepper("Text", () => cur.fontScale, (v) => { cur.fontScale = clampScale(v, FONT_MIN, FONT_MAX); push(); }, FONT_STEP),
    button("Reset", "btn small", () => { cur.uiScale = 1; cur.fontScale = 1; row.querySelectorAll(".device-val").forEach((n) => n.textContent = "100%"); push(); }),
    button("Remove", "btn small danger", async () => {
      const label = d.name || d.id.slice(0, 8);
      const ok = await savebar.confirmDialog({
        title: "Remove display?",
        message: `“${label}” drops off the list, along with its size overlay. It reappears if that screen loads the dashboard again.`,
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await fetch(`/api/devices/${encodeURIComponent(d.id)}`, { method: "DELETE" });
        if (!res.ok && res.status !== 404) { toast("Remove failed: " + res.status, "err"); return; }
        toast("Display removed", "ok");
        openDisplays();
      } catch (e) { toast("Remove failed: " + e.message, "err"); }
    }),
  );

  // which pages this display shows ("All" = empty list = follow the rotation)
  const pagesRow = document.createElement("div"); pagesRow.className = "device-pages";
  const lbl = document.createElement("span"); lbl.className = "device-steplabel"; lbl.textContent = "Shows";
  pagesRow.appendChild(lbl);
  const allChip = document.createElement("button");
  allChip.type = "button"; allChip.className = "day-chip" + (cur.pages.length ? "" : " on"); allChip.textContent = "All";
  const pageChips = pages().map((p) => {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "day-chip" + (cur.pages.includes(p.id) ? " on" : "");
    c.textContent = p.name || p.id;
    c.onclick = () => {
      c.classList.toggle("on");
      cur.pages = pageChips.filter((x) => x.chip.classList.contains("on")).map((x) => x.id);
      allChip.classList.toggle("on", !cur.pages.length);
      push();
    };
    pagesRow.appendChild(c);
    return { id: p.id, chip: c };
  });
  allChip.onclick = () => {
    cur.pages = [];
    pageChips.forEach((x) => x.chip.classList.remove("on"));
    allChip.classList.add("on");
    push();
  };
  pagesRow.insertBefore(allChip, pagesRow.children[1] || null);

  row.append(info, controls, pagesRow);
  return row;
}

function scaleStepper(label, get, set, step) {
  const wrap = document.createElement("div"); wrap.className = "device-stepper";
  const l = document.createElement("span"); l.className = "device-steplabel"; l.textContent = label;
  const val = document.createElement("span"); val.className = "device-val";
  val.textContent = Math.round(get() * 100) + "%";
  const render = () => { val.textContent = Math.round(get() * 100) + "%"; };
  const minus = button("−", "btn small", () => { set(get() - step); render(); });
  const plus = button("+", "btn small", () => { set(get() + step); render(); });
  wrap.append(l, minus, val, plus);
  return wrap;
}

async function restoreBackup(b) {
  const when = new Date(b.savedAt).toLocaleString();
  // Restore writes on the server immediately, so unsaved local edits would be
  // stranded on top of a config they were never derived from. Say so first.
  const dirty = store.isDirty();
  const ok = await savebar.confirmDialog({
    title: "Restore this backup?",
    message: dirty
      ? `The backup from ${when} (v${b.version}) becomes the current config, and your unsaved changes will be discarded. ` +
        "The version you have now is itself kept in history."
      : `The backup from ${when} (v${b.version}) becomes the current config. ` +
        "The version you have now is itself kept in history, so this is reversible.",
    confirmLabel: dirty ? "Discard my changes and restore" : "Restore",
    danger: dirty,
  });
  if (!ok) return;
  try {
    const restored = await api.restoreBackup(b.name);
    savebar.clearDraft();
    store.reset(restored);
    onConfigReplaced(restored);
    toast(`Restored v${b.version} · now v${restored.version}`, "ok");
  } catch (e) { toast("Restore failed: " + e.message, "err"); }
}

// ---- toast + wiring ---------------------------------------------------------

// ---- toasts -----------------------------------------------------------------
//
// A stack rather than one overwriting element, with two rules that matter:
//   · errors never auto-dismiss (a failed save that vanishes in 3s is a failed
//     save the user never sees) — they get an explicit close button;
//   · identical messages collapse into one row with a ×N counter, so holding a
//     device stepper produces "Display updated ×10" instead of ten toasts.

const TOAST_MAX = 4;
const _toasts = new Map(); // key -> { el, count, countEl, timer }

function dismissToast(key) {
  const t = _toasts.get(key);
  if (!t) return;
  clearTimeout(t.timer);
  t.el.remove();
  _toasts.delete(key);
}

function toast(msg, kind) {
  const stack = $("#toast-stack");
  if (!stack) return;
  const key = (kind || "") + "|" + msg;

  const existing = _toasts.get(key);
  if (existing) {
    existing.count += 1;
    existing.countEl.textContent = "×" + existing.count;
    existing.countEl.classList.remove("hidden");
    stack.appendChild(existing.el); // re-sort to newest
    clearTimeout(existing.timer);
    if (kind !== "err") existing.timer = setTimeout(() => dismissToast(key), 3000);
    return;
  }

  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  const text = document.createElement("span");
  text.textContent = msg;
  const countEl = document.createElement("span");
  countEl.className = "toast-count hidden";
  el.append(text, countEl);

  if (kind === "err") {
    const x = document.createElement("button");
    x.className = "toast-x";
    x.type = "button";
    x.textContent = "×";
    x.title = "Dismiss";
    x.onclick = () => dismissToast(key);
    el.appendChild(x);
  }

  stack.appendChild(el);
  const entry = { el, count: 1, countEl, timer: null };
  _toasts.set(key, entry);
  if (kind !== "err") entry.timer = setTimeout(() => dismissToast(key), 3000);

  // Oldest-first eviction, but never drop an error the user hasn't seen.
  while (_toasts.size > TOAST_MAX) {
    const oldest = [..._toasts.entries()].find(([, t]) => !t.el.classList.contains("err"));
    if (!oldest) break;
    dismissToast(oldest[0]);
  }
}

// inject a "Tidy up" button next to "+ Add widget"
// Canvas header. Everything that used to be a topbar button now lives on the
// rail (built by renderRail) or in the System panel.
$("#btn-add").onclick = () => openEditor(null);
$("#btn-preview").onclick = togglePreview;
$("#btn-tidy").onclick = tidyUp;
$("#btn-palette").onclick = openPalette;

// Filter the widget strip. Purely a view filter — it never touches the config.
$("#widget-filter").addEventListener("input", () => renderList());

// Clicking empty canvas deselects and returns the inspector to the page.
$("#canvas").addEventListener("pointerdown", (e) => {
  if (e.target !== e.currentTarget && !e.target.classList.contains("guide-layer")) return;
  if (state.editingId == null && !state.selection.size) return;
  showDefault();
});

// Live / Static. Live rendering is the point of the canvas, but anyone who
// finds it distracting (or is on a slow Pi) can switch the whole thing off.
$("#btn-live").onclick = () => {
  liveHost.setLive(!liveHost.isLive());
  $("#btn-live").setAttribute("aria-pressed", String(liveHost.isLive()));
  $("#btn-live").textContent = liveHost.isLive() ? "Live" : "Static";
  renderCanvas();
};

// ---- keyboard editing -------------------------------------------------------
// The canvas was pointer-only. Arrows nudge, Shift resizes, and everything is
// one undo step per burst thanks to the store's coalesce keys.

document.addEventListener("keydown", (e) => {
  // The palette is reachable from anywhere, including mid-typing — that's the
  // point of it. Everything below it is canvas editing and must not fire while
  // the user is in a field.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (!document.querySelector(".modal-backdrop")) openPalette();
    return;
  }

  const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || "")
    || document.activeElement?.isContentEditable;
  if (typing || document.querySelector(".modal-backdrop")) return;

  const ws = selectedWidgets();
  const cols = state.config.settings?.columns || 12;

  if (e.key === "Escape" && (state.editingId || state.selection.size)) {
    e.preventDefault(); showDefault(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && currentWidgets().length) {
    e.preventDefault();
    state.editingId = null;
    state.selection = new Set(currentWidgets().map((w) => w.id));
    renderCanvas(); renderList(); openBulk();
    return;
  }
  if (!ws.length) return;

  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    ws.length > 1 ? bulkDelete() : delWidget(ws[0].id);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
    e.preventDefault();
    if (ws.length === 1) duplicateWidget(ws[0].id);
    return;
  }

  const DIRS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const d = DIRS[e.key];
  if (!d) return;
  e.preventDefault();
  const [dx, dy] = d;
  const ids = new Set(ws.map((w) => w.id));
  const next = ws.map((w) => {
    const g = { ...w.grid };
    if (e.shiftKey) {
      g.w = clamp(g.w + dx, 1, cols - g.x);
      g.h = Math.max(1, g.h + dy);
    } else {
      g.x = clamp(g.x + dx, 0, cols - g.w);
      g.y = Math.max(0, g.y + dy);
    }
    return { id: w.id, g };
  });
  if (next.some((n) => collides(n.g, ids))) { toast("Blocked — something's in the way"); return; }
  for (const n of next) Object.assign(ws.find((w) => w.id === n.id).grid, n.g);
  renderCanvas();
  const what = ws.length > 1 ? `${ws.length} widgets` : (ws[0].title || ws[0].type);
  save(`${e.shiftKey ? "resized" : "moved"} ${what}`, { coalesce: `nudge:${[...ids].join(",")}:${e.shiftKey}` });
});

renderRail();
load();
