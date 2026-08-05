// Three-way merge for the 409 path.
//
// When another tab (or the Pi itself) saves while you have unsaved work, the
// old admin called load() and threw everything away behind a 3-second toast.
// Instead we diff at the granularity of *addressable entities* — a page, a
// widget, one settings leaf, one ordering array — against the version we
// originally loaded. Edits to different entities merge silently, which covers
// the overwhelmingly common real case of two tabs touching different things.
// Only genuine same-entity collisions reach the user.
//
// DOM-free — see core/clone.js.

import { clone, deepEqual } from "../core/clone.js";

// ---- entity extraction ------------------------------------------------------

// Keys are strings so they can be Map keys, compared, and shown in the resolver.
// The prefix tells the applier which container the value belongs to.
const SETTINGS_LEAF = (path) => `settings.${path}`;
const PAGE = (id) => `page:${id}`;
const WIDGET = (pageId, id) => `widget:${pageId}:${id}`;
const SCENE = (id) => `scene:${id}`;

function walkLeaves(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    // Arrays are leaves: reordering one is a single user intent, not N edits.
    if (v && typeof v === "object" && !Array.isArray(v)) walkLeaves(v, path, out);
    else out.set(SETTINGS_LEAF(path), v);
  }
}

/** Flatten a config into key -> value. Missing keys mean "entity absent". */
export function entities(cfg) {
  const out = new Map();
  if (!cfg) return out;

  walkLeaves(cfg.settings, "", out);

  out.set("rotation.enabled", cfg.rotation?.enabled);
  out.set("rotation.defaultDurationSeconds", cfg.rotation?.defaultDurationSeconds);
  out.set("rotation.order", cfg.rotation?.order ?? []);
  out.set("activeSceneId", cfg.activeSceneId ?? null);
  out.set("sceneManualHold", cfg.sceneManualHold ?? false);

  out.set("pageOrder", (cfg.pages || []).map((p) => p.id));
  for (const page of cfg.pages || []) {
    const { widgets, ...rest } = page;
    out.set(PAGE(page.id), rest);
    out.set(`widgetOrder:${page.id}`, (widgets || []).map((w) => w.id));
    for (const w of widgets || []) out.set(WIDGET(page.id, w.id), w);
  }

  out.set("sceneOrder", (cfg.scenes || []).map((s) => s.id));
  for (const s of cfg.scenes || []) out.set(SCENE(s.id), s);

  return out;
}

// ---- merge ------------------------------------------------------------------

const ABSENT = Symbol("absent");
const read = (map, key) => (map.has(key) ? map.get(key) : ABSENT);
const same = (a, b) => (a === ABSENT || b === ABSENT ? a === b : deepEqual(a, b));

/**
 * @returns {{ merged: Map, conflicts: Array<{key, kind, mine, theirs, base}> }}
 *   `merged` holds the auto-resolved value for every key; conflicting keys are
 *   seeded with `theirs` so an un-resolved merge is still a valid config.
 */
export function mergeEntities(base, mine, theirs) {
  const merged = new Map();
  const conflicts = [];
  const keys = new Set([...base.keys(), ...mine.keys(), ...theirs.keys()]);

  for (const key of keys) {
    const b = read(base, key);
    const m = read(mine, key);
    const t = read(theirs, key);

    const iChanged = !same(b, m);
    const theyChanged = !same(b, t);

    if (!iChanged) {
      if (t !== ABSENT) merged.set(key, t);
      continue;
    }
    if (!theyChanged) {
      if (m !== ABSENT) merged.set(key, m);
      continue;
    }
    if (same(m, t)) {                       // both made the same edit
      if (m !== ABSENT) merged.set(key, m);
      continue;
    }

    // Both moved, differently.
    const kind =
      m === ABSENT ? "deleted-by-you-edited-by-them"
      : t === ABSENT ? "edited-by-you-deleted-by-them"
      : "both-edited";
    conflicts.push({ key, kind, base: b === ABSENT ? null : b, mine: m === ABSENT ? null : m, theirs: t === ABSENT ? null : t });
    if (t !== ABSENT) merged.set(key, t);   // default to theirs until resolved
  }

  return { merged, conflicts };
}

// ---- rebuild ----------------------------------------------------------------

function rebuildSettings(merged) {
  const settings = {};
  for (const [key, value] of merged) {
    if (!key.startsWith("settings.")) continue;
    const parts = key.slice("settings.".length).split(".");
    let cur = settings;
    for (let i = 0; i < parts.length - 1; i++) cur = (cur[parts[i]] ??= {});
    cur[parts.at(-1)] = value;
  }
  return settings;
}

/**
 * Turn a resolved entity map back into a config.
 *
 * `theirs` supplies the frame — its `version` (so the retried PUT is gated on
 * what the server actually holds) and any top-level key this module doesn't
 * model, so a future schema field can't be silently dropped by a merge.
 */
export function rebuild(merged, theirs) {
  const out = clone(theirs);
  out.settings = rebuildSettings(merged);
  out.rotation = {
    enabled: merged.get("rotation.enabled") ?? false,
    defaultDurationSeconds: merged.get("rotation.defaultDurationSeconds") ?? 30,
    order: merged.get("rotation.order") ?? [],
  };
  out.activeSceneId = merged.get("activeSceneId") ?? null;
  out.sceneManualHold = merged.get("sceneManualHold") ?? false;

  // An id in the order array whose entity didn't survive the merge was deleted;
  // an entity with no slot in the order array is likewise gone.
  out.pages = (merged.get("pageOrder") ?? [])
    .filter((id) => merged.has(PAGE(id)))
    .map((id) => ({
      ...merged.get(PAGE(id)),
      widgets: (merged.get(`widgetOrder:${id}`) ?? [])
        .filter((wid) => merged.has(WIDGET(id, wid)))
        .map((wid) => merged.get(WIDGET(id, wid))),
    }));

  out.scenes = (merged.get("sceneOrder") ?? [])
    .filter((id) => merged.has(SCENE(id)))
    .map((id) => merged.get(SCENE(id)));

  return out;
}

/**
 * Full three-way merge.
 * @returns {{ config, conflicts, clean: boolean }} — `clean` means it can be
 *   retried against the server without asking the user anything.
 */
export function merge(base, mine, theirs) {
  const { merged, conflicts } = mergeEntities(entities(base), entities(mine), entities(theirs));
  return { config: rebuild(merged, theirs), conflicts, clean: conflicts.length === 0 };
}

/**
 * Re-run a merge with explicit per-key choices.
 * @param choices Map<key, "mine"|"theirs">
 */
export function resolve(base, mine, theirs, choices) {
  const bE = entities(base), mE = entities(mine), tE = entities(theirs);
  const { merged, conflicts } = mergeEntities(bE, mE, tE);
  for (const [key, pick] of choices) {
    const src = pick === "mine" ? mE : tE;
    if (src.has(key)) merged.set(key, src.get(key));
    else merged.delete(key);
  }
  const unresolved = conflicts.filter((c) => !choices.has(c.key));
  return { config: rebuild(merged, theirs), conflicts: unresolved, clean: unresolved.length === 0 };
}

/** Human label for a conflict row in the resolver. */
export function describeKey(key, cfg) {
  if (key === "pageOrder") return "Page order";
  if (key === "sceneOrder") return "Scene order";
  if (key.startsWith("settings.")) return `Setting: ${key.slice("settings.".length)}`;
  if (key.startsWith("rotation.")) return `Rotation: ${key.slice("rotation.".length)}`;
  if (key.startsWith("widgetOrder:")) {
    const id = key.slice("widgetOrder:".length);
    return `Widget order on ${cfg?.pages?.find((p) => p.id === id)?.name || id}`;
  }
  if (key.startsWith("widget:")) {
    const [, pageId, wid] = key.split(":");
    const page = cfg?.pages?.find((p) => p.id === pageId);
    const w = page?.widgets?.find((x) => x.id === wid);
    return `Widget: ${w?.title || wid}`;
  }
  if (key.startsWith("page:")) {
    const id = key.slice("page:".length);
    return `Page: ${cfg?.pages?.find((p) => p.id === id)?.name || id}`;
  }
  if (key.startsWith("scene:")) {
    const id = key.slice("scene:".length);
    return `Scene: ${cfg?.scenes?.find((s) => s.id === id)?.name || id}`;
  }
  return key;
}
