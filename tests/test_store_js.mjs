// Node smoke tests for admin/js/core/store.js and core/clone.js.
import assert from "node:assert/strict";
import * as store from "../admin/js/core/store.js";
import { deepEqual, getPath, setPath } from "../admin/js/core/clone.js";

const cfg = (over = {}) => ({
  version: 1,
  settings: { title: "T", columns: 12 },
  pages: [{ id: "p1", name: "Home", widgets: [{ id: "w1", type: "clock", title: "Clock" }] }],
  ...over,
});

// ---- clone helpers ---------------------------------------------------------
{
  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true, "key order must not matter");
  assert.equal(deepEqual([1, 2], [2, 1]), false, "array order must matter");
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false, "extra key is a change");

  assert.equal(getPath({ a: { b: [{ c: 7 }] } }, "a.b.0.c"), 7);
  assert.equal(getPath({ a: null }, "a.b.c"), undefined, "must not throw through null");

  const t = {};
  setPath(t, "a.b.c", 1);
  assert.deepEqual(t, { a: { b: { c: 1 } } });
  setPath(t, "list.0.x", 5);
  assert.ok(Array.isArray(t.list), "numeric segment creates an array");
}

// ---- reset / dirty ---------------------------------------------------------
{
  store._reset();
  store.reset(cfg());
  assert.equal(store.isDirty(), false);
  assert.equal(store.snapshot().changeCount, 0);

  store.commit("rename page", (d) => { d.pages[0].name = "Living room"; });
  assert.equal(store.isDirty(), true);
  assert.equal(store.get().pages[0].name, "Living room");
  assert.equal(store.getBaseline().pages[0].name, "Home", "baseline must not move");
}

// ---- snapshots are isolated ------------------------------------------------
{
  store._reset();
  const original = cfg();
  store.reset(original);
  store.commit("edit", (d) => { d.pages[0].widgets[0].title = "Mutated"; });
  assert.equal(original.pages[0].widgets[0].title, "Clock",
    "committing must not reach back into the caller's object");
}

// ---- no-op commits do not pollute undo -------------------------------------
{
  store._reset();
  store.reset(cfg());
  const changed = store.commit("touch nothing", (d) => { d.settings.title = "T"; });
  assert.equal(changed, false);
  assert.equal(store.snapshot().changeCount, 0);
  assert.equal(store.isDirty(), false);
}

// ---- aborting a commit -----------------------------------------------------
{
  store._reset();
  store.reset(cfg());
  const changed = store.commit("abort", (d) => { d.settings.title = "X"; return false; });
  assert.equal(changed, false);
  assert.equal(store.get().settings.title, "T");
}

// ---- undo / redo -----------------------------------------------------------
{
  store._reset();
  store.reset(cfg());
  store.commit("first", (d) => { d.settings.title = "A"; });
  store.commit("second", (d) => { d.settings.title = "B"; });
  assert.equal(store.snapshot().changeCount, 2);

  assert.equal(store.undo(), "second");
  assert.equal(store.get().settings.title, "A");
  assert.equal(store.snapshot().canRedo, true);

  assert.equal(store.redo(), "second");
  assert.equal(store.get().settings.title, "B");

  store.undo(); store.undo();
  assert.equal(store.get().settings.title, "T");
  assert.equal(store.isDirty(), false, "undoing back to baseline is clean again");
  assert.equal(store.undo(), null, "undo past the start is a no-op");
}

// ---- a new commit clears the redo stack ------------------------------------
{
  store._reset();
  store.reset(cfg());
  store.commit("a", (d) => { d.settings.title = "A"; });
  store.undo();
  store.commit("b", (d) => { d.settings.title = "B"; });
  assert.equal(store.snapshot().canRedo, false);
}

// ---- coalescing ------------------------------------------------------------
{
  store._reset();
  store.reset(cfg());
  for (let i = 1; i <= 5; i++) {
    store.commit(`nudge to ${i}`, (d) => { d.pages[0].widgets[0].x = i; }, { coalesce: "nudge:w1" });
  }
  assert.equal(store.snapshot().changeCount, 1, "a run of nudges is one undo entry");
  assert.equal(store.snapshot().undoLabel, "nudge to 5", "label tracks the latest nudge");

  store.commit("something else", (d) => { d.settings.title = "Z"; });
  store.commit("nudge to 6", (d) => { d.pages[0].widgets[0].x = 6; }, { coalesce: "nudge:w1" });
  assert.equal(store.snapshot().changeCount, 3, "an interruption breaks the run");

  store.undo();
  assert.equal(store.get().pages[0].widgets[0].x, 5, "undo steps back over the whole run's tail");
}

// ---- change log ------------------------------------------------------------
{
  store._reset();
  store.reset(cfg());
  store.commit("added Clock", (d) => { d.pages[0].widgets.push({ id: "w2", type: "clock" }); });
  store.commit("moved Weather", (d) => { d.pages[0].widgets[0].title = "moved"; });
  assert.deepEqual(store.changeLog(), ["moved Weather", "added Clock"], "newest first");
}

// ---- discard / markSaved ---------------------------------------------------
{
  store._reset();
  store.reset(cfg());
  store.commit("edit", (d) => { d.settings.title = "Dirty"; });
  store.discard();
  assert.equal(store.get().settings.title, "T");
  assert.equal(store.isDirty(), false);
  assert.equal(store.snapshot().canUndo, false, "discard clears history");

  store.commit("edit again", (d) => { d.settings.title = "Saved"; });
  store.markSaved({ ...store.get(), version: 2 });
  assert.equal(store.isDirty(), false);
  assert.equal(store.get().version, 2);
  assert.equal(store.snapshot().canUndo, true, "markSaved keeps undo history");
}

// ---- subscribers -----------------------------------------------------------
{
  store._reset();
  let seen = 0;
  const off = store.subscribe(() => { seen += 1; });
  store.reset(cfg());
  store.commit("edit", (d) => { d.settings.title = "A"; });
  assert.equal(seen, 2, "reset and commit both notify");
  off();
  store.commit("edit2", (d) => { d.settings.title = "B"; });
  assert.equal(seen, 2, "unsubscribed listener stops firing");
}

console.log("store: ok");
