// The config store: one source of truth, snapshot undo, explicit save.
//
// Why snapshots rather than a command/inverse-op log: writing a correct inverse
// for "change grid columns with proportional rescale" or "restore a backup" is
// where undo implementations break. A realistic config is tens of KB, so a
// structuredClone is sub-millisecond and 50 of them is a couple of MB. Wrong
// trade at 10 MB; right trade here.
//
// DOM-free — see core/clone.js.

import { clone, deepEqual } from "./clone.js";

const LIMIT = 50;

let present = null;
let baseline = null;      // last server-confirmed config
let past = [];            // [{ label, config, coalesce }]
let future = [];
const listeners = new Set();

function emit() {
  const snap = snapshot();
  for (const fn of listeners) fn(snap);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function snapshot() {
  return {
    config: present,
    dirty: isDirty(),
    changeCount: past.length,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    undoLabel: past.at(-1)?.label ?? null,
    redoLabel: future.at(-1)?.label ?? null,
  };
}

export const get = () => present;
export const getBaseline = () => baseline;
export const isDirty = () => !!present && !!baseline && !deepEqual(present, baseline);

/** Adopt a server response as the new clean state, discarding local history. */
export function reset(config) {
  present = clone(config);
  baseline = clone(config);
  past = [];
  future = [];
  emit();
}

/** Adopt a saved config as clean without touching undo history. */
export function markSaved(config) {
  present = clone(config);
  baseline = clone(config);
  emit();
}

/**
 * Apply a mutation as one undoable step.
 *
 * The mutator receives a fresh deep clone and mutates it freely; the *previous*
 * object is what gets pushed onto the undo stack, so every snapshot is already
 * isolated — no aliasing bugs and no need to deep-freeze anything.
 *
 * @param label     human text shown in the changes list and undo toast
 * @param mutator   (draft) => void | false — returning false aborts the commit
 * @param coalesce  key; consecutive commits sharing one collapse into a single
 *                  undo entry (arrow-key nudges, stepper repeats)
 */
export function commit(label, mutator, { coalesce = null } = {}) {
  if (!present) return false;
  const before = present;
  const draft = clone(present);
  if (mutator(draft) === false) return false;
  if (deepEqual(draft, before)) return false;   // no-op: don't pollute undo

  if (!coalesce || past.at(-1)?.coalesce !== coalesce) {
    past.push({ label, config: before, coalesce });
    if (past.length > LIMIT) past.shift();
  } else {
    // Same coalesce run: keep the original "before" but adopt the newer label.
    past.at(-1).label = label;
  }
  future.length = 0;
  present = draft;
  emit();
  return true;
}

/**
 * Commit an already-mutated config as one undoable step.
 *
 * `commit` suits callers that describe a change as a function. This suits the
 * other shape: code that holds a long-lived mutable working copy, edits it in
 * place, and then says "that was a change". The value is cloned on the way in,
 * so the caller keeps its object identity and the history stays isolated.
 */
export function commitValue(label, value, { coalesce = null } = {}) {
  if (!present) return false;
  if (deepEqual(value, present)) return false;

  if (!coalesce || past.at(-1)?.coalesce !== coalesce) {
    past.push({ label, config: present, coalesce });
    if (past.length > LIMIT) past.shift();
  } else {
    past.at(-1).label = label;
  }
  future.length = 0;
  present = clone(value);
  emit();
  return true;
}

export function undo() {
  const entry = past.pop();
  if (!entry) return null;
  future.push({ label: entry.label, config: present, coalesce: entry.coalesce });
  present = entry.config;
  emit();
  return entry.label;
}

export function redo() {
  const entry = future.pop();
  if (!entry) return null;
  past.push({ label: entry.label, config: present, coalesce: entry.coalesce });
  present = entry.config;
  emit();
  return entry.label;
}

/** Throw away local edits and go back to the last server-confirmed config. */
export function discard() {
  if (!baseline) return;
  present = clone(baseline);
  past = [];
  future = [];
  emit();
}

/**
 * Plain-English list of what changed since the last save, newest first.
 * Derived from undo labels rather than a JSON diff — "moved Weather" is what
 * the user did; a diff of grid.x is not.
 */
export function changeLog() {
  return past.map((e) => e.label).reverse();
}

/** Test seam: drop all state. */
export function _reset() {
  present = null;
  baseline = null;
  past = [];
  future = [];
  listeners.clear();
}
