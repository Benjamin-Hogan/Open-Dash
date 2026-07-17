// Schema-driven admin with multi-page layouts, a visual drag/resize editor, and
// slideshow-mode config. ONE write path: PUT /api/config gated on the loaded
// version (409 → re-sync). Widget position/size are edited on the canvas; the
// form handles type + settings only.
import * as registry from "/widgets/index.js";
import { buildEmbedDoc } from "/widgets/embed.js";

const state = { config: null, activePage: 0, editingId: null };
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
    const [cfgRes, metaRes] = await Promise.all([
      fetch("/api/config"),
      fetch("/api/meta").catch(() => null),
    ]);
    if (!cfgRes.ok) throw new Error(`config ${cfgRes.status}`);
    state.config = await cfgRes.json();
    if (metaRes?.ok) {
      const meta = await metaRes.json();
      if (meta.dashboardPort) dashPort = meta.dashboardPort;
    }
    if (!pages().length) pages().push({ id: "page-1", name: "Home", widgets: [] });
    state.activePage = Math.min(state.activePage, pages().length - 1);
    $("#version").textContent = "v" + state.config.version;
    renderAll();
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

function renderPageBar() {
  const bar = $("#page-bar");
  bar.replaceChildren();
  pages().forEach((p, i) => {
    const tab = document.createElement("button");
    tab.className = "page-tab" + (i === state.activePage ? " active" : "");
    tab.textContent = p.name || "Page";
    if (rotation().enabled && p.durationSeconds) tab.title = `Shows for ${p.durationSeconds}s`;
    tab.onclick = () => { state.activePage = i; renderAll(); };
    bar.appendChild(tab);
  });
  const add = document.createElement("button");
  add.className = "page-add";
  add.textContent = "＋ Page";
  add.onclick = addPage;
  bar.appendChild(add);

  // actions for the active page
  const acts = document.createElement("div");
  acts.className = "page-actions";
  const mk = (label, cls, fn) => { const b = document.createElement("button"); b.className = "btn small " + (cls || ""); b.textContent = label; b.onclick = fn; return b; };
  acts.append(
    mk("Rename", "", () => renamePage(state.activePage)),
    mk("Duration", "", () => durationPage(state.activePage)),
    mk("Schedule", pages()[state.activePage]?.schedule?.enabled ? "scheduled" : "", () => openPageSchedule(state.activePage)),
    mk("Duplicate", "", () => duplicatePage(state.activePage)),
    mk("←", "", () => movePage(state.activePage, -1)),
    mk("→", "", () => movePage(state.activePage, 1)),
    mk("Delete page", "danger", () => deletePage(state.activePage)),
  );
  bar.appendChild(acts);
}

function addPage() {
  const id = "page-" + Date.now().toString(36);
  pages().push({ id, name: "New page", widgets: [] });
  state.activePage = pages().length - 1;
  save();
}
function renamePage(i) {
  const name = prompt("Page name:", pages()[i].name || "");
  if (name == null) return;
  pages()[i].name = name.trim() || "Page";
  save();
}
function durationPage(i) {
  const cur = pages()[i].durationSeconds ?? "";
  const v = prompt(`Slideshow duration for this page in seconds (blank = use default ${rotation().defaultDurationSeconds}s):`, cur);
  if (v == null) return;
  pages()[i].durationSeconds = v.trim() === "" ? null : Math.max(2, Number(v) || 2);
  save();
}
function duplicatePage(i) {
  const src = pages()[i];
  const clone = structuredClone(src);
  clone.id = "page-" + Date.now().toString(36);
  clone.name = (src.name || "Page") + " copy";
  // regenerate widget ids so they stay tidy
  for (const w of clone.widgets || []) w.id = `${w.type}-${Math.random().toString(36).slice(2, 8)}`;
  pages().splice(i + 1, 0, clone);
  state.activePage = i + 1;
  save();
}
function movePage(i, d) {
  const j = i + d;
  if (j < 0 || j >= pages().length) return;
  const ps = pages();
  [ps[i], ps[j]] = [ps[j], ps[i]];
  state.activePage = j;
  save();
}
function deletePage(i) {
  if (pages().length <= 1) { toast("Keep at least one page", "err"); return; }
  if (!confirm(`Delete page “${pages()[i].name}” and its widgets?`)) return;
  pages().splice(i, 1);
  state.activePage = Math.max(0, Math.min(state.activePage, pages().length - 1));
  save();
}

// ---- visual layout editor (canvas) ------------------------------------------

function renderCanvas() {
  const canvas = $("#canvas");
  canvas.replaceChildren();
  const cols = state.config.settings?.columns || 12;
  const widgets = currentWidgets();
  const maxRow = widgets.reduce((m, w) => Math.max(m, (w.grid?.y || 0) + (w.grid?.h || 3)), 0);
  const rows = Math.max(maxRow + 1, 8);
  canvas.style.setProperty("--cols", cols);
  canvas.style.setProperty("--rows", rows);
  canvas.style.setProperty("--editor-row", EDITOR_ROW + "px");
  canvas.style.setProperty("--canvas-gap", CANVAS_GAP + "px");
  const bad = problems(cols);
  widgets.forEach((w) => {
    if (!w.grid) w.grid = { x: 0, y: 0, w: 4, h: 3 };
    const box = makeBox(w, cols);
    if (bad.has(w.id)) box.classList.add("overlap");
    canvas.appendChild(box);
  });
  if (!widgets.length) {
    canvas.appendChild(Object.assign(document.createElement("div"), { className: "canvas-empty", textContent: "No widgets on this page — click “+ Add widget”." }));
  }
  updateHint(bad.size);
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
  save();
}

function placeBox(box, w) {
  box.style.gridColumn = `${w.grid.x + 1} / span ${w.grid.w}`;
  box.style.gridRow = `${w.grid.y + 1} / span ${w.grid.h}`;
}

function makeBox(w, cols) {
  const plugin = registry.get(w.type);
  const box = document.createElement("div");
  box.className = "canvas-box" + (w.enabled === false ? " disabled" : "");
  placeBox(box, w);

  const label = document.createElement("div");
  label.className = "box-label";
  label.innerHTML = `<span class="box-title"></span><span class="box-type"></span>`;
  label.querySelector(".box-title").textContent = w.title || "(untitled)";
  label.querySelector(".box-type").textContent = (plugin?.meta?.label) || w.type;
  box.appendChild(label);

  const tools = document.createElement("div");
  tools.className = "box-tools";
  const edit = document.createElement("button");
  edit.className = "box-btn"; edit.textContent = "✎"; edit.title = "Edit";
  edit.onclick = (e) => { e.stopPropagation(); openEditor(w.id); };
  const del = document.createElement("button");
  del.className = "box-btn"; del.textContent = "🗑"; del.title = "Delete";
  del.onclick = (e) => { e.stopPropagation(); delWidget(w.id); };
  tools.append(edit, del);
  box.appendChild(tools);

  const handle = document.createElement("div");
  handle.className = "resize-handle";
  box.appendChild(handle);

  box.addEventListener("pointerdown", (e) => startDrag(e, w, box, cols, "move"));
  handle.addEventListener("pointerdown", (e) => { e.stopPropagation(); startDrag(e, w, box, cols, "resize"); });
  return box;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function startDrag(e, w, box, cols, mode) {
  if (e.target.closest(".box-btn")) return; // let buttons click
  e.preventDefault();
  const canvas = $("#canvas");
  const cellW = canvas.getBoundingClientRect().width / cols;
  const cellH = EDITOR_ROW + CANVAS_GAP;
  const start = { x: e.clientX, y: e.clientY };
  const orig = { ...w.grid };
  box.setPointerCapture(e.pointerId);
  box.classList.add("dragging");

  const onMove = (ev) => {
    const dx = Math.round((ev.clientX - start.x) / cellW);
    const dy = Math.round((ev.clientY - start.y) / cellH);
    if (mode === "move") {
      w.grid.x = clamp(orig.x + dx, 0, cols - w.grid.w);
      w.grid.y = Math.max(0, orig.y + dy);
    } else {
      w.grid.w = clamp(orig.w + dx, 1, cols - w.grid.x);
      w.grid.h = Math.max(1, orig.h + dy);
    }
    placeBox(box, w);
  };
  const onUp = () => {
    box.releasePointerCapture(e.pointerId);
    box.classList.remove("dragging");
    box.removeEventListener("pointermove", onMove);
    box.removeEventListener("pointerup", onUp);
    const changed = orig.x !== w.grid.x || orig.y !== w.grid.y || orig.w !== w.grid.w || orig.h !== w.grid.h;
    if (changed) { renderCanvas(); save(); } // re-render to grow the canvas if needed
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
  if (!widgets.length) return;
  widgets.forEach((w, i) => {
    const plugin = registry.get(w.type);
    const row = document.createElement("div");
    row.className = "wrow" + (w.enabled === false ? " disabled" : "");
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
  save();
}

function duplicateWidget(id) {
  const ws = currentWidgets();
  const w = ws.find((x) => x.id === id);
  if (!w) return;
  const clone = structuredClone(w);
  clone.id = `${w.type}-${Date.now().toString(36)}`;
  clone.title = (w.title || "") + " copy";
  clone.grid = { ...(w.grid || { x: 0, y: 0, w: 4, h: 3 }) };
  clone.grid.y = (clone.grid.y || 0) + (clone.grid.h || 3); // drop it just below
  ws.push(clone);
  save();
}

function copyWidgetTo(id) {
  const w = currentWidgets().find((x) => x.id === id);
  if (!w) return;
  const ps = pages();
  const menu = ps.map((p, i) => `${i + 1}) ${p.name}`).join("\n");
  const ans = prompt(`Copy “${w.title || w.id}” to which page?\n${menu}`, "");
  if (ans == null) return;
  const idx = Number(ans) - 1;
  if (!(idx >= 0 && idx < ps.length)) { toast("Invalid page number", "err"); return; }
  const clone = structuredClone(w);
  clone.id = `${w.type}-${Date.now().toString(36)}`;
  (ps[idx].widgets || (ps[idx].widgets = [])).push(clone);
  save();
  toast(`Copied to “${ps[idx].name}”`, "ok");
}

function toggle(id) {
  const w = currentWidgets().find((x) => x.id === id);
  if (w) { w.enabled = w.enabled === false; save(); }
}
function delWidget(id) {
  const ws = currentWidgets();
  const i = ws.findIndex((x) => x.id === id);
  if (i < 0) return;
  if (!confirm(`Delete “${ws[i].title || ws[i].id}”?`)) return;
  ws.splice(i, 1);
  save();
}

// ---- widget editor (type + settings; grid handled on canvas) ----------------

function nextFreeRow() {
  return currentWidgets().reduce((m, w) => Math.max(m, (w.grid?.y || 0) + (w.grid?.h || 3)), 0);
}

function openEditor(id) {
  const editor = $("#editor");
  editor.classList.remove("hidden");
  const existing = currentWidgets().find((w) => w.id === id);
  const widget = existing
    ? structuredClone(existing)
    : { id: "", type: registry.types()[0], title: "", enabled: true, grid: { x: 0, y: nextFreeRow(), w: 4, h: 3 }, settings: {} };
  if (widget.type === "slideshow") {
    widget.slideshow = widget.slideshow || { enabled: true, durationSeconds: 30, slides: [] };
  }
  state.editingId = existing ? id : null;
  renderForm(editor, widget);
}

function renderForm(editor, widget) {
  editor.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = state.editingId ? "Edit widget" : "Add widget";
  h.style.margin = "0 0 12px";
  editor.appendChild(h);

  editor.appendChild(field("Type", select(registry.types(), widget.type, (v) => {
    const next = gather(editor, widget);
    next.type = v;
    next.settings = {};
    if (v !== "slideshow") next.slideshow = null;
    else next.slideshow = next.slideshow || { enabled: true, durationSeconds: 30, slides: [] };
    renderForm(editor, next);
  })));
  editor.appendChild(field("Title", input("text", widget.title, "title")));
  editor.appendChild(boolField("Enabled", widget.enabled !== false, "enabled"));

  const plugin = registry.get(widget.type);
  const fields = (plugin?.schema?.fields || []).filter((f) => f.key !== "_slidesNote");
  if (fields.length) editor.appendChild(sectionTitle("Settings"));
  for (const f of fields) editor.appendChild(renderField(f, widget));

  editor.appendChild(field("Refresh seconds (blank = none)", input("number", widget.refreshSeconds ?? "", "refreshSeconds")));
  editor.appendChild(noteEl("Position & size are set by dragging on the layout canvas."));

  editor.appendChild(sectionTitle("Schedule"));
  editor.appendChild(noteEl("Hide this widget outside a time window (same rules as page schedules)."));
  appendScheduleFields(editor, widget.schedule || {}, "ws");

  if (widget.type === "slideshow") {
    editor.appendChild(sectionTitle("Slides"));
    appendSlideshowFields(editor, widget);
  }

  const actions = document.createElement("div");
  actions.className = "editor-actions";
  actions.append(
    button("Cancel", "btn", () => { editor.classList.add("hidden"); state.editingId = null; }),
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
  if (w.type === "slideshow") w.slideshow = gatherSlideshow(editor, w);
  else w.slideshow = null;
  return w;
}

async function commit(editor, widget) {
  const w = gather(editor, widget);
  if (!w.id) w.id = `${w.type}-${Date.now().toString(36)}`;
  const ws = currentWidgets();
  const idx = ws.findIndex((x) => x.id === state.editingId);
  if (idx >= 0) ws[idx] = w; else ws.push(w);
  editor.classList.add("hidden");
  state.editingId = null;
  await save();
}

// ---- single write path (queued so rapid canvas drags can't 409 mid-edit) ----

let saving = false;
let saveAgain = false;

async function save() {
  if (saving) { saveAgain = true; return; }
  saving = true;
  try {
    do {
      saveAgain = false;
      await saveOnce();
    } while (saveAgain);
  } finally {
    saving = false;
  }
}

async function saveOnce() {
  try {
    const res = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.config),
    });
    if (res.status === 409) { toast("Config changed elsewhere — reloading latest", "err"); await load(); return; }
    if (res.status === 422) {
      const d = await res.json();
      toast("Invalid: " + JSON.stringify(d.detail?.[0]?.msg || d.detail), "err");
      return;
    }
    if (!res.ok) { toast("Save failed: " + res.status, "err"); return; }
    state.config = await res.json();
    state.activePage = Math.min(state.activePage, pages().length - 1);
    $("#version").textContent = "v" + state.config.version;
    renderAll();
    toast("Saved · v" + state.config.version, "ok");
  } catch (e) {
    toast("Save error: " + e.message, "err");
  }
}

// ---- slideshow settings -----------------------------------------------------

function openSlideshow() {
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.replaceChildren();
  state.editingId = null;
  const h = document.createElement("h2"); h.textContent = "Slideshow mode"; h.style.margin = "0 0 6px";
  editor.appendChild(h);
  editor.appendChild(noteEl("Rotate through pages on a timer. Set a per-page override with the page “Duration” button."));
  const r = rotation();
  editor.appendChild(boolField("Enable slideshow (rotate pages)", r.enabled === true, "rot-enabled"));
  editor.appendChild(field("Default seconds per page", input("number", r.defaultDurationSeconds ?? 30, "rot-default")));
  const actions = document.createElement("div"); actions.className = "editor-actions";
  actions.append(
    button("Cancel", "btn", () => editor.classList.add("hidden")),
    button("Save", "btn primary", () => {
      r.enabled = editor.querySelector('[data-name="rot-enabled"]').checked;
      const d = Number(editor.querySelector('[data-name="rot-default"]').value);
      r.defaultDurationSeconds = Math.max(2, d || 30);
      editor.classList.add("hidden");
      save();
    }),
  );
  editor.appendChild(actions);
}

// ---- alert auto-dismiss settings --------------------------------------------

function alertsSettings() {
  const s = state.config.settings || (state.config.settings = {});
  return s.alerts || (s.alerts = { infoTtlSeconds: 90, warningTtlSeconds: 0, dangerTtlSeconds: 0 });
}

function openAlerts() {
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.replaceChildren();
  state.editingId = null;
  const a = alertsSettings();

  const h = document.createElement("h2"); h.textContent = "Alerts"; h.style.margin = "0 0 6px";
  editor.appendChild(h);
  editor.appendChild(noteEl("How long banner alerts stay on screen before auto-dismissing (including weather). Set 0 to keep until someone taps ✕ or the official weather expiry (✕ clears every display and stays dismissed until NWS cancels it). Saving new times also updates alerts already on screen."));

  editor.appendChild(field("Info alerts (seconds, 0 = keep)", input("number", a.infoTtlSeconds ?? 90, "al-info")));
  editor.appendChild(field("Warning alerts (seconds, 0 = keep)", input("number", a.warningTtlSeconds ?? 0, "al-warning")));
  editor.appendChild(field("Danger alerts (seconds, 0 = keep)", input("number", a.dangerTtlSeconds ?? 0, "al-danger")));
  editor.appendChild(noteEl("Defaults: info = 90s, warning/danger = keep until dismissed. Save, then use Test alert to preview."));

  const actions = document.createElement("div"); actions.className = "editor-actions";
  actions.append(
    button("Cancel", "btn", () => editor.classList.add("hidden")),
    button("Save", "btn primary", () => {
      const read = (name) => Math.max(0, Math.round(Number(editor.querySelector(`[data-name="${name}"]`).value) || 0));
      a.infoTtlSeconds = read("al-info");
      a.warningTtlSeconds = read("al-warning");
      a.dangerTtlSeconds = read("al-danger");
      editor.classList.add("hidden");
      save();
    }),
  );
  editor.appendChild(actions);
}

// ---- scenes (named context presets) -----------------------------------------

function openScenes() {
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.replaceChildren();
  state.editingId = null;

  const h = document.createElement("h2"); h.textContent = "Scenes"; h.style.margin = "0 0 6px";
  editor.appendChild(h);
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
    button("Clear / follow schedules", "btn small", async () => {
      state.config.activeSceneId = null;
      state.config.sceneManualHold = false;
      await save();
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
  actions.append(button("Close", "btn", () => editor.classList.add("hidden")));
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
    button("Activate", "btn small primary", async () => {
      state.config.activeSceneId = sc.id;
      state.config.sceneManualHold = true;
      await save();
      openScenes();
    }),
    button("Edit", "btn small", () => openSceneEditor(sc.id)),
    button("Delete", "btn small danger", async () => {
      if (!confirm(`Delete scene “${sc.name}”?`)) return;
      const idx = scenes().findIndex((s) => s.id === sc.id);
      if (idx >= 0) scenes().splice(idx, 1);
      if (state.config.activeSceneId === sc.id) {
        state.config.activeSceneId = null;
        state.config.sceneManualHold = false;
      }
      await save();
      openScenes();
    }),
  );
  row.append(info, controls);
  return row;
}

function openSceneEditor(sceneId) {
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.replaceChildren();
  state.editingId = null;

  const existing = sceneId ? scenes().find((s) => s.id === sceneId) : null;
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
      if (idx >= 0) scenes()[idx] = draft;
      else scenes().push(draft);
      await save();
      openScenes();
    }),
  );
  editor.appendChild(actions);
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
  const d = document.createElement("div"); d.className = "field";
  const l = document.createElement("label"); l.style.display = "flex"; l.style.gap = "8px"; l.style.alignItems = "center";
  const c = document.createElement("input"); c.type = "checkbox"; c.checked = checked; c.dataset.name = name; c.id = `f-${name}`; c.style.width = "auto";
  const span = document.createElement("span"); span.textContent = label;
  l.append(c, span); d.appendChild(l); return d;
}
function button(text, cls, fn) { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = text; b.onclick = fn; return b; }

// ---- shared schedule fields (page + widget) ---------------------------------

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function appendScheduleFields(editor, schedule, prefix) {
  const s = schedule || {};
  editor.appendChild(boolField("Enable schedule", s.enabled === true, `${prefix}-enabled`));
  editor.appendChild(field("Start (HH:MM)", input("time", s.start || "", `${prefix}-start`)));
  editor.appendChild(field("End (HH:MM)", input("time", s.end || "", `${prefix}-end`)));
  const dayWrap = document.createElement("div");
  dayWrap.className = "day-picker";
  dayWrap.dataset.name = `${prefix}-days`;
  DAY_LABELS.forEach((label, d) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day-chip" + ((s.days || []).includes(d) ? " on" : "");
    b.textContent = label;
    b.dataset.day = d;
    b.onclick = () => b.classList.toggle("on");
    dayWrap.appendChild(b);
  });
  editor.appendChild(field("Days (none selected = every day)", dayWrap));
}

function gatherSchedule(editor, prefix) {
  const enabled = editor.querySelector(`[data-name="${prefix}-enabled"]`)?.checked === true;
  const start = editor.querySelector(`[data-name="${prefix}-start"]`)?.value || null;
  const end = editor.querySelector(`[data-name="${prefix}-end"]`)?.value || null;
  const dayWrap = editor.querySelector(`[data-name="${prefix}-days"]`);
  const days = dayWrap
    ? [...dayWrap.querySelectorAll(".day-chip.on")].map((b) => Number(b.dataset.day))
    : [];
  if (!enabled && !start && !end && !days.length) return null;
  return { enabled, start, end, days };
}

// ---- slideshow widget slides editor ----------------------------------------

function slideTypeOptions() {
  return registry.types().filter((t) => t !== "slideshow");
}

function appendSlideshowFields(editor, widget) {
  const cfg = widget.slideshow || { enabled: true, durationSeconds: 30, slides: [] };
  widget.slideshow = cfg;
  if (!Array.isArray(cfg.slides)) cfg.slides = [];

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
        cur.slides[i] = { type: v, title: cur.slides[i]?.title || "", settings: {} };
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

  editor.appendChild(button("+ Add slide", "btn", () => {
    const cur = gatherSlideshow(editor, widget);
    const types = slideTypeOptions();
    cur.slides.push({ type: types[0], title: "", settings: {} });
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
      // Preserve prior password values when blank (same as top-level widgets).
      const prev = widget.slideshow?.slides?.[i];
      if (prev?.settings) {
        for (const [k, v] of Object.entries(prev.settings)) {
          if ((k === "apiKey" || k.toLowerCase().includes("key")) && !settings[k] && v) settings[k] = v;
        }
      }
      slides.push({ type, title, settings });
    });
  }
  return { enabled: true, durationSeconds: duration, slides };
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
  ta.placeholder = "Paste a TradingView (or any <div>+<script>) snippet…";
  ta.style.minHeight = "120px";

  const sel = document.createElement("select");
  sel.style.marginTop = "6px";
  const ph = document.createElement("option"); ph.value = ""; ph.textContent = "Quick-fill a preset…";
  sel.appendChild(ph);
  (f.presets || []).forEach((p, i) => {
    const o = document.createElement("option"); o.value = String(i); o.textContent = p.label; sel.appendChild(o);
  });

  const preview = document.createElement("iframe");
  preview.className = "embed-preview";
  preview.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms");
  Object.assign(preview.style, { width: "100%", height: "200px", marginTop: "8px",
    border: "1px solid var(--border, #2a3a5e)", borderRadius: "8px", background: "#0c142e" });
  const previewLabel = noteEl("Live preview");
  previewLabel.style.marginTop = "8px";

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
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.replaceChildren();
  state.editingId = null;
  const h = document.createElement("h2"); h.textContent = "API keys"; h.style.margin = "0 0 4px";
  editor.appendChild(h);
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
    button("Cancel", "btn", () => editor.classList.add("hidden")),
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
        editor.classList.add("hidden");
      } catch (e) { toast("Save failed: " + e.message, "err"); }
    }),
  );
  editor.appendChild(actions);
}

// ---- backups / restore ------------------------------------------------------

async function openBackups() {
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.replaceChildren();
  state.editingId = null;
  const h = document.createElement("h2"); h.textContent = "Backups"; h.style.margin = "0 0 4px";
  editor.appendChild(h);
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
  actions.append(button("Close", "btn", () => editor.classList.add("hidden")));
  editor.appendChild(actions);
}

// ---- page schedule (time-window visibility for the whole page) ---------------
// Same Schedule shape widgets use (days 0=Mon..6=Sun, HH:MM window, may wrap
// past midnight). Displays skip the page outside the window.

function openPageSchedule(i) {
  const page = pages()[i];
  if (!page) return;
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.replaceChildren();
  state.editingId = null;

  const h = document.createElement("h2"); h.textContent = `Schedule — ${page.name}`; h.style.margin = "0 0 6px";
  editor.appendChild(h);
  editor.appendChild(noteEl("Show this page only during a time window. Outside it, the slideshow skips the page (and a display assigned only this page falls back to the others). The window may wrap past midnight, e.g. 21:00 → 06:00."));
  appendScheduleFields(editor, page.schedule || {}, "ps");

  const actions = document.createElement("div"); actions.className = "editor-actions";
  actions.append(
    button("Cancel", "btn", () => editor.classList.add("hidden")),
    button("Save", "btn primary", () => {
      page.schedule = gatherSchedule(editor, "ps");
      editor.classList.add("hidden");
      save();
    }),
  );
  editor.appendChild(actions);
}

// ---- layout & grid (resize granularity) -------------------------------------
// columns / rowHeightPx / gapPx are the grid widgets snap to on the canvas, so
// they ARE the resize granularity. This grid is shared by every display. Raising
// the column count would normally reflow every widget (they keep their numbers
// but now span a smaller fraction), so we offer a proportional rescale that
// keeps the current look while making the steps finer.

function openLayout() {
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.replaceChildren();
  state.editingId = null;
  const s = state.config.settings || (state.config.settings = {});
  const theme = s.theme || (s.theme = { mode: "dark", accent: "#4aa3ff" });
  const oldCols = s.columns || 12, oldRow = s.rowHeightPx || 90, oldGap = s.gapPx ?? 12;

  const h = document.createElement("h2"); h.textContent = "Layout & appearance"; h.style.margin = "0 0 6px";
  editor.appendChild(h);

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
    button("Cancel", "btn", () => editor.classList.add("hidden")),
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
  editor.classList.add("hidden");
  save();
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
  const editor = $("#editor");
  editor.classList.remove("hidden");
  editor.replaceChildren();
  state.editingId = null;
  const h = document.createElement("h2"); h.textContent = "Displays"; h.style.margin = "0 0 6px";
  editor.appendChild(h);
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
  actions.append(button("Close", "btn", () => editor.classList.add("hidden")));
  editor.appendChild(actions);
}

function deviceRow(d) {
  const row = document.createElement("div"); row.className = "device-row";
  const seen = d.lastSeen ? new Date(d.lastSeen * 1000) : null;
  const stale = seen ? (Date.now() - seen.getTime()) > 90_000 : true;

  const info = document.createElement("div"); info.className = "device-info";
  const name = document.createElement("div"); name.className = "device-name";
  name.textContent = d.name || `Display ${d.id.slice(0, 4)}`;
  const meta = document.createElement("div"); meta.className = "device-meta";
  meta.textContent = [
    d.viewport || "unknown size",
    `id ${d.id.slice(0, 8)}`,
    seen ? (stale ? "last seen " + seen.toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "online") : "never seen",
  ].join(" · ");
  if (!stale) row.classList.add("online");
  info.append(name, meta);

  // Live-editable local copy; PUT (debounced) on each nudge.
  const cur = { uiScale: d.uiScale ?? 1, fontScale: d.fontScale ?? 1, pages: [...(d.pages || [])] };
  let putTimer = null;
  const push = () => {
    clearTimeout(putTimer);
    putTimer = setTimeout(() => {
      fetch(`/api/devices/${encodeURIComponent(d.id)}/prefs`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uiScale: cur.uiScale, fontScale: cur.fontScale, pages: cur.pages }),
      }).then((r) => { if (r.ok) toast("Display updated", "ok"); }).catch(() => toast("Update failed", "err"));
    }, 350);
  };

  const controls = document.createElement("div"); controls.className = "device-controls";
  controls.append(
    scaleStepper("Size", () => cur.uiScale, (v) => { cur.uiScale = clampScale(v, UI_MIN, UI_MAX); push(); }, UI_STEP),
    scaleStepper("Text", () => cur.fontScale, (v) => { cur.fontScale = clampScale(v, FONT_MIN, FONT_MAX); push(); }, FONT_STEP),
    button("Reset", "btn small", () => { cur.uiScale = 1; cur.fontScale = 1; row.querySelectorAll(".device-val").forEach((n) => n.textContent = "100%"); push(); }),
    button("Remove", "btn small danger", async () => {
      const label = d.name || d.id.slice(0, 8);
      if (!confirm(`Remove “${label}” from the display list? It will reappear if that screen loads the dashboard again.`)) return;
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
  if (!confirm(`Restore the backup from ${when} (v${b.version})? This becomes the current config.`)) return;
  try {
    const res = await fetch("/api/backups/restore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: b.name }),
    });
    if (!res.ok) { toast("Restore failed: " + res.status, "err"); return; }
    state.config = await res.json();
    $("#editor").classList.add("hidden");
    await load();
    toast(`Restored v${b.version} · now v${state.config.version}`, "ok");
  } catch (e) { toast("Restore error: " + e.message, "err"); }
}

// ---- toast + wiring ---------------------------------------------------------

let toastTimer;
function toast(msg, kind) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast " + (kind || "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 3000);
}

// inject a "Tidy up" button next to "+ Add widget"
(function addTidyButton() {
  const host = document.querySelector(".panel-head-actions");
  if (!host) return;
  const b = document.createElement("button");
  b.className = "btn small";
  b.textContent = "Tidy up";
  b.title = "Auto-arrange widgets with no gaps or overlaps";
  b.onclick = tidyUp;
  host.insertBefore(b, $("#btn-add"));
})();

$("#btn-layout").onclick = openLayout;
$("#btn-scenes").onclick = openScenes;
$("#btn-keys").onclick = openKeys;
$("#btn-displays").onclick = openDisplays;
$("#btn-backups").onclick = openBackups;
$("#btn-slideshow").onclick = openSlideshow;
$("#btn-alerts").onclick = openAlerts;
$("#btn-add").onclick = () => openEditor(null);
$("#btn-preview").onclick = togglePreview;
$("#btn-test-alert").onclick = async () => {
  try {
    const r = await fetch("/api/alerts/test", { method: "POST" });
    toast(r.ok ? "Test alert sent to all displays" : "Test alert failed", r.ok ? "ok" : "err");
  } catch (e) { toast("Test alert failed: " + e.message, "err"); }
};
$("#btn-clear").onclick = async () => {
  try {
    const r = await fetch("/api/cache/clear", { method: "POST" });
    if (!r.ok) { toast("Clear cache failed: " + r.status, "err"); return; }
    const d = await r.json();
    toast(`Cache cleared (${d.cleared})`, "ok");
  } catch (e) { toast("Clear cache failed: " + e.message, "err"); }
};
$("#btn-refresh").onclick = async () => {
  try {
    const r = await fetch("/api/refresh", { method: "POST" });
    toast(r.ok ? "Dashboards refreshing" : "Refresh failed: " + r.status, r.ok ? "ok" : "err");
  } catch (e) { toast("Refresh failed: " + e.message, "err"); }
};

load();
