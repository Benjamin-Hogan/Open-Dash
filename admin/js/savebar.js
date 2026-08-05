// The save model: staged edits, explicit Save, undo/redo, draft recovery and
// conflict resolution.
//
// The old admin PUT the whole config on every drag, delete and reorder, with no
// undo and no way back — and a 409 from a second tab called load(), silently
// discarding everything local. Here nothing goes over the wire until you press
// Save; edits still apply instantly on screen, they're just undoable.
//
// This module owns the topbar controls and the conflict UI. It deliberately
// keeps its own DOM here rather than in index.html so the shell markup stays
// small while the app is mid-restructure.

import * as store from "./core/store.js";
import * as api from "./core/api.js";
import * as sse from "./core/sse.js";
import { merge, resolve, describeKey } from "./model/merge.js";
import { clone } from "./core/clone.js";

const DRAFT_KEY = "admin.draft";
const CONFLICT_BACKUP_PREFIX = "admin.conflict-backup.";

let ui = null;
let hooks = { onExternalConfig: null, toast: () => {}, confirm: null };
let saving = false;
let outsideVersion = null;   // a version another client saved while we were dirty

// ---- draft persistence ------------------------------------------------------
// No autosave, but no silent loss either: a crashed or accidentally-closed tab
// gets its work back. Keyed by the baseline version so a draft can never be
// re-applied on top of a config it wasn't derived from.

let draftTimer = null;

function writeDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      if (!store.isDirty()) { localStorage.removeItem(DRAFT_KEY); return; }
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        savedAt: Date.now(),
        baseVersion: store.getBaseline()?.version,
        config: store.get(),
      }));
    } catch { /* storage full or disabled — draft recovery is a nicety */ }
  }, 500);
}

function readDraft(currentVersion) {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (d.baseVersion !== currentVersion) { localStorage.removeItem(DRAFT_KEY); return null; }
    return d;
  } catch { return null; }
}

export function clearDraft() {
  clearTimeout(draftTimer);
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

function stashConflictBackup(config) {
  const key = CONFLICT_BACKUP_PREFIX + Date.now();
  try { localStorage.setItem(key, JSON.stringify(config)); } catch { return null; }
  return key;
}

function ago(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "less than a minute ago";
  if (mins === 1) return "a minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.round(mins / 60);
  return h === 1 ? "an hour ago" : `${h} hours ago`;
}

// ---- topbar -----------------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

function buildBar(host) {
  const undo = el("button", { class: "btn ghost icon", type: "button", title: "Undo (Ctrl+Z)", "aria-label": "Undo" }, "↶");
  const redo = el("button", { class: "btn ghost icon", type: "button", title: "Redo (Ctrl+Shift+Z)", "aria-label": "Redo" }, "↷");
  const changes = el("button", { class: "badge", type: "button", title: "Show what changed" }, "No changes");
  const discard = el("button", { class: "btn ghost small", type: "button", title: "Throw away unsaved changes" }, "Discard");
  const save = el("button", { class: "btn primary", type: "button", title: "Save to the dashboard (Ctrl+S)" }, "Save");

  undo.onclick = () => doUndo();
  redo.onclick = () => doRedo();
  changes.onclick = () => showChanges();
  discard.onclick = () => doDiscard();
  save.onclick = () => saveNow();

  const wrap = el("div", { class: "savebar" }, [undo, redo, changes, discard, save]);
  host.prepend(wrap);
  return { wrap, undo, redo, changes, discard, save };
}

function render() {
  if (!ui) return;
  const s = store.snapshot();
  ui.undo.disabled = !s.canUndo;
  ui.redo.disabled = !s.canRedo;
  ui.undo.title = s.canUndo ? `Undo: ${s.undoLabel} (Ctrl+Z)` : "Nothing to undo";
  ui.redo.title = s.canRedo ? `Redo: ${s.redoLabel} (Ctrl+Shift+Z)` : "Nothing to redo";

  // Counts actions taken, not net differences — two edits that cancel out still
  // read as two edits, and the list says what they were. "changes" would imply
  // a diff count and overstate it.
  const n = s.changeCount;
  ui.changes.textContent = s.dirty ? `${n} unsaved ${n === 1 ? "edit" : "edits"}` : "No changes";
  ui.changes.classList.toggle("accent", s.dirty);
  ui.changes.disabled = !s.dirty;
  ui.discard.classList.toggle("hidden", !s.dirty);
  ui.save.disabled = !s.dirty || saving;
  ui.save.textContent = saving ? "Saving…" : "Save";
  ui.wrap.classList.toggle("dirty", s.dirty);

  writeDraft();
  renderOutsideBanner();
}

// ---- outside-change banner --------------------------------------------------

function renderOutsideBanner() {
  const existing = document.querySelector("#outside-banner");
  if (outsideVersion == null) { existing?.remove(); return; }
  if (existing) return;

  const n = store.snapshot().changeCount;
  const banner = el("div", { class: "banner", id: "outside-banner", role: "status" }, [
    el("span", { class: "banner-body" },
      `Someone else saved v${outsideVersion}. You have ${n} unsaved ${n === 1 ? "change" : "changes"} — saving will merge them.`),
    el("button", { class: "btn small", type: "button", onclick: () => reviewOutside() }, "Review"),
    el("button", { class: "btn small ghost", type: "button", onclick: () => { outsideVersion = null; renderOutsideBanner(); } }, "Keep mine"),
  ]);
  document.body.insertBefore(banner, document.body.firstChild);
}

async function reviewOutside() {
  try {
    const theirs = await api.loadConfig();
    const r = merge(store.getBaseline(), store.get(), theirs);
    if (r.clean) {
      hooks.toast("Your changes and theirs don't overlap — Save will merge cleanly.", "ok");
    } else {
      openConflictModal(r.conflicts, theirs);
    }
  } catch (e) {
    hooks.toast("Could not fetch the other version: " + e.message, "err");
  }
}

// ---- changes list -----------------------------------------------------------

function showChanges() {
  const log = store.changeLog();
  const body = log.length
    ? el("ol", { class: "change-list" }, log.map((t) => el("li", {}, t)))
    : el("div", { class: "empty" }, [el("div", { class: "empty-title" }, "No unsaved changes")]);
  openModal({
    title: "Unsaved changes",
    body,
    actions: [
      { label: "Discard all", cls: "btn danger", onClick: (close) => { close(); doDiscard(); } },
      { label: "Close", cls: "btn", onClick: (close) => close() },
    ],
  });
}

// ---- modal ------------------------------------------------------------------
// A real focus-trapped dialog. Every confirm()/prompt() in the admin becomes one
// of these.

export function openModal({ title, body, actions = [], wide = false }) {
  const prevFocus = document.activeElement;
  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true", "aria-label": title });

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    prevFocus?.focus?.();
  };

  const foot = el("div", { class: "modal-foot" }, actions.map((a) =>
    el("button", { class: a.cls || "btn", type: "button", onclick: () => a.onClick(close) }, a.label)));

  modal.append(
    el("div", { class: "modal-head" }, [el("div", { class: "modal-title" }, title)]),
    el("div", { class: "modal-body" }, [body]),
    foot,
  );
  backdrop.appendChild(modal);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });

  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    const f = [...modal.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
      .filter((n) => !n.disabled && n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", onKey, true);

  document.body.appendChild(backdrop);
  (modal.querySelector(".modal-foot button:last-child") || modal).focus?.();
  return close;
}

/** Promise-based confirm, replacing window.confirm. */
export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((res) => {
    openModal({
      title,
      body: el("p", { class: "note" }, message),
      actions: [
        { label: "Cancel", cls: "btn", onClick: (close) => { close(); res(false); } },
        { label: confirmLabel, cls: danger ? "btn danger primary" : "btn primary", onClick: (close) => { close(); res(true); } },
      ],
    });
  });
}

// ---- conflict resolver ------------------------------------------------------

function openConflictModal(conflicts, theirs) {
  const choices = new Map();
  const list = el("div", { class: "list" });

  const KIND_TEXT = {
    "both-edited": "Edited in both places",
    "deleted-by-you-edited-by-them": "You deleted it; they edited it",
    "edited-by-you-deleted-by-them": "You edited it; they deleted it",
  };

  for (const c of conflicts) {
    const row = el("div", { class: "list-row conflict-row" });
    const pick = (which, btnMine, btnTheirs) => {
      choices.set(c.key, which);
      btnMine.setAttribute("aria-pressed", String(which === "mine"));
      btnTheirs.setAttribute("aria-pressed", String(which === "theirs"));
    };
    const mineBtn = el("button", { class: "btn small", type: "button", "aria-pressed": "false" }, "Keep mine");
    const theirsBtn = el("button", { class: "btn small", type: "button", "aria-pressed": "true" }, "Take theirs");
    mineBtn.onclick = () => pick("mine", mineBtn, theirsBtn);
    theirsBtn.onclick = () => pick("theirs", mineBtn, theirsBtn);
    choices.set(c.key, "theirs");

    row.append(
      el("div", { class: "list-row-main" }, [
        el("div", { class: "list-row-title" }, describeKey(c.key, theirs)),
        el("div", { class: "list-row-meta" }, KIND_TEXT[c.kind] || c.kind),
      ]),
      el("div", { class: "conflict-actions" }, [mineBtn, theirsBtn]),
    );
    list.appendChild(row);
  }

  const body = el("div", {}, [
    el("p", { class: "note" },
      `${conflicts.length} ${conflicts.length === 1 ? "item was" : "items were"} changed in both places. ` +
      "Everything else merged automatically. Your version is backed up before anything is overwritten."),
    list,
  ]);

  openModal({
    title: "Resolve conflicts",
    wide: true,
    body,
    actions: [
      { label: "Download my version", cls: "btn ghost", onClick: () => downloadMine() },
      { label: "Take all theirs", cls: "btn", onClick: (close) => {
        for (const c of conflicts) choices.set(c.key, "theirs");
        close(); applyResolution(choices, theirs);
      } },
      { label: "Cancel", cls: "btn", onClick: (close) => close() },
      { label: "Merge and save", cls: "btn primary", onClick: (close) => { close(); applyResolution(choices, theirs); } },
    ],
  });
}

function downloadMine() {
  const blob = new Blob([JSON.stringify(store.get(), null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `dashboard.config.v${store.get()?.version}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function applyResolution(choices, theirs) {
  const backupKey = stashConflictBackup(store.get());
  const r = resolve(store.getBaseline(), store.get(), theirs, choices);
  await pushConfig(r.config, { merged: true, backupKey });
}

// ---- saving -----------------------------------------------------------------

async function pushConfig(config, { merged = false, backupKey = null } = {}) {
  saving = true;
  render();
  try {
    const saved = await api.saveConfig(config);
    store.reset(saved);
    outsideVersion = null;
    clearDraft();
    hooks.onExternalConfig?.(saved, { reason: "saved" });
    hooks.toast(
      merged
        ? `Merged with the other version · saved as v${saved.version}` +
          (backupKey ? " (your pre-merge version is backed up)" : "")
        : `Saved · v${saved.version}`,
      "ok",
    );
    return true;
  } catch (e) {
    if (e.status === 409) return handleStale();
    if (e.status === 422) {
      const errs = api.validationErrors(e.detail);
      hooks.toast(`Can't save: ${errs[0]?.path ? errs[0].path + " — " : ""}${errs[0]?.message}`, "err");
      hooks.onValidationErrors?.(errs);
      return false;
    }
    hooks.toast("Save failed: " + e.message, "err");
    return false;
  } finally {
    saving = false;
    render();
  }
}

async function handleStale() {
  let theirs;
  try {
    theirs = await api.loadConfig();
  } catch (e) {
    hooks.toast("Save conflicted and the newer version could not be fetched: " + e.message, "err");
    return false;
  }
  const r = merge(store.getBaseline(), store.get(), theirs);
  if (r.clean) {
    // Disjoint edits — retry against their version without asking.
    return pushConfig(r.config, { merged: true });
  }
  openConflictModal(r.conflicts, theirs);
  return false;
}

export async function saveNow() {
  if (saving || !store.isDirty()) return false;
  return pushConfig(store.get());
}

// ---- actions ----------------------------------------------------------------

function doUndo() {
  const label = store.undo();
  if (!label) return;
  hooks.onExternalConfig?.(store.get(), { reason: "undo" });
  hooks.toast("Undid: " + label);
}

function doRedo() {
  const label = store.redo();
  if (!label) return;
  hooks.onExternalConfig?.(store.get(), { reason: "redo" });
  hooks.toast("Redid: " + label);
}

async function doDiscard() {
  if (!store.isDirty()) return;
  const n = store.snapshot().changeCount;
  const ok = await confirmDialog({
    title: "Discard changes?",
    message: `${n} unsaved ${n === 1 ? "change" : "changes"} will be thrown away and the dashboard will go back to the last saved version.`,
    confirmLabel: "Discard",
    danger: true,
  });
  if (!ok) return;
  store.discard();
  clearDraft();
  hooks.onExternalConfig?.(store.get(), { reason: "discard" });
  hooks.toast("Changes discarded");
}

// ---- init -------------------------------------------------------------------

export function init({ host, onExternalConfig, onValidationErrors, toast }) {
  hooks = { onExternalConfig, onValidationErrors, toast: toast || (() => {}) };
  ui = buildBar(host);
  store.subscribe(render);
  render();

  sse.on("config-changed", ({ version } = {}) => {
    const baseline = store.getBaseline();
    if (!baseline || version === baseline.version) return;
    if (!store.isDirty()) {
      // Nothing local to lose: quietly adopt the newer config.
      api.loadConfig().then((cfg) => {
        store.reset(cfg);
        hooks.onExternalConfig?.(cfg, { reason: "external" });
      }).catch(() => {});
      return;
    }
    outsideVersion = version;
    renderOutsideBanner();
  });
  sse.connect();

  window.addEventListener("beforeunload", (e) => {
    if (!store.isDirty()) return;
    e.preventDefault();
    e.returnValue = "";
  });

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    // Don't steal undo from a text field the user is typing in.
    const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || "");
    if (key === "s") { e.preventDefault(); saveNow(); }
    else if (key === "z" && !typing) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
    else if (key === "y" && !typing) { e.preventDefault(); doRedo(); }
  });
}

/** Offer to restore a draft left behind by a crashed or closed tab. */
export function offerDraftRecovery(currentVersion, apply) {
  const d = readDraft(currentVersion);
  if (!d) return;
  openModal({
    title: "Restore unsaved changes?",
    body: el("p", { class: "note" },
      `This tab had unsaved changes from ${ago(d.savedAt)} that were never saved to the dashboard. ` +
      "They still apply to the current version."),
    actions: [
      { label: "Discard them", cls: "btn", onClick: (close) => { close(); clearDraft(); } },
      { label: "Restore", cls: "btn primary", onClick: (close) => { close(); apply(d.config); } },
    ],
  });
}
