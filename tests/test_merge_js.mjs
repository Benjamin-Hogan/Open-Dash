// Node smoke tests for admin/js/model/merge.js — the 409 recovery path.
import assert from "node:assert/strict";
import { merge, resolve, entities, describeKey } from "../admin/js/model/merge.js";

const base = () => ({
  version: 5,
  settings: {
    title: "Dash",
    columns: 12,
    theme: { mode: "dark", accent: "#4aa3ff" },
    location: { lat: 33.4, lon: -112.0, city: "Phoenix", region: "AZ" },
  },
  rotation: { enabled: false, defaultDurationSeconds: 30, order: [] },
  pages: [
    {
      id: "p1", name: "Home",
      widgets: [
        { id: "w1", type: "clock", title: "Clock", grid: { x: 0, y: 0, w: 3, h: 2 } },
        { id: "w2", type: "weather", title: "Weather", grid: { x: 3, y: 0, w: 4, h: 3 } },
      ],
    },
    { id: "p2", name: "Radar", widgets: [] },
  ],
  scenes: [],
  activeSceneId: null,
  sceneManualHold: false,
});

const edit = (fn) => { const c = structuredClone(base()); fn(c); return c; };
const w = (cfg, pid, wid) => cfg.pages.find((p) => p.id === pid).widgets.find((x) => x.id === wid);

// ---- entity extraction -----------------------------------------------------
{
  const e = entities(base());
  assert.equal(e.get("settings.theme.accent"), "#4aa3ff", "nested settings flatten to leaves");
  assert.deepEqual(e.get("pageOrder"), ["p1", "p2"]);
  assert.deepEqual(e.get("widgetOrder:p1"), ["w1", "w2"]);
  assert.ok(e.has("widget:p1:w2"));
  assert.equal(e.get("page:p1").widgets, undefined, "page entity excludes its widgets");
}

// ---- disjoint edits auto-merge (the common two-tab case) -------------------
{
  const mine = edit((c) => { w(c, "p1", "w1").title = "My Clock"; });
  const theirs = edit((c) => { c.version = 6; w(c, "p1", "w2").title = "Their Weather"; });

  const r = merge(base(), mine, theirs);
  assert.equal(r.clean, true, "different widgets must not conflict");
  assert.equal(w(r.config, "p1", "w1").title, "My Clock");
  assert.equal(w(r.config, "p1", "w2").title, "Their Weather");
  assert.equal(r.config.version, 6, "retry must be gated on the server's version");
}

// ---- disjoint settings leaves also merge -----------------------------------
{
  const mine = edit((c) => { c.settings.theme.accent = "#ff0000"; });
  const theirs = edit((c) => { c.version = 6; c.settings.location.city = "Tucson"; });

  const r = merge(base(), mine, theirs);
  assert.equal(r.clean, true, "leaf granularity: two settings keys are independent");
  assert.equal(r.config.settings.theme.accent, "#ff0000");
  assert.equal(r.config.settings.location.city, "Tucson");
  assert.equal(r.config.settings.theme.mode, "dark", "untouched leaves survive");
}

// ---- same entity, different values → conflict ------------------------------
{
  const mine = edit((c) => { w(c, "p1", "w1").title = "Mine"; });
  const theirs = edit((c) => { c.version = 6; w(c, "p1", "w1").title = "Theirs"; });

  const r = merge(base(), mine, theirs);
  assert.equal(r.clean, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].key, "widget:p1:w1");
  assert.equal(r.conflicts[0].kind, "both-edited");
  assert.equal(w(r.config, "p1", "w1").title, "Theirs", "unresolved defaults to theirs");
}

// ---- identical edits on both sides are not a conflict ----------------------
{
  const mine = edit((c) => { c.settings.title = "Same"; });
  const theirs = edit((c) => { c.version = 6; c.settings.title = "Same"; });
  assert.equal(merge(base(), mine, theirs).clean, true);
}

// ---- ordering is one unit --------------------------------------------------
{
  const mine = edit((c) => { c.pages[0].widgets.reverse(); });
  const theirs = edit((c) => { c.version = 6; c.settings.title = "X"; });
  const r = merge(base(), mine, theirs);
  assert.equal(r.clean, true);
  assert.deepEqual(r.config.pages[0].widgets.map((x) => x.id), ["w2", "w1"]);

  // Reordering does not touch the widget objects themselves, so "I reordered,
  // they renamed" is disjoint and must merge.
  const reorderVsRename = merge(
    base(),
    edit((c) => { c.pages[0].widgets.reverse(); }),
    edit((c) => { c.version = 6; w(c, "p1", "w2").title = "Renamed"; }),
  );
  assert.equal(reorderVsRename.clean, true);
  assert.deepEqual(reorderVsRename.config.pages[0].widgets.map((x) => x.id), ["w2", "w1"]);
  assert.equal(w(reorderVsRename.config, "p1", "w2").title, "Renamed");

  // Two *different* orders are a genuine collision on the one ordering entity.
  const threeWide = structuredClone(base());
  threeWide.pages[0].widgets.push({ id: "w3", type: "rss", title: "News", grid: { x: 0, y: 3, w: 4, h: 4 } });
  const order = (ids) => {
    const c = structuredClone(threeWide);
    c.pages[0].widgets.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return c;
  };
  const bothReorder = merge(threeWide, order(["w3", "w1", "w2"]), { ...order(["w2", "w3", "w1"]), version: 6 });
  assert.equal(bothReorder.clean, false);
  assert.deepEqual(bothReorder.conflicts.map((x) => x.key), ["widgetOrder:p1"]);
}

// ---- adds ------------------------------------------------------------------
{
  const mine = edit((c) => {
    c.pages[0].widgets.push({ id: "w3", type: "rss", title: "News", grid: { x: 0, y: 3, w: 4, h: 4 } });
  });
  const theirs = edit((c) => { c.version = 6; w(c, "p1", "w1").title = "Theirs"; });

  const r = merge(base(), mine, theirs);
  assert.equal(r.clean, true, "adding a widget while they edit another is disjoint");
  assert.equal(r.config.pages[0].widgets.length, 3);
  assert.ok(w(r.config, "p1", "w3"), "my new widget survives");
  assert.equal(w(r.config, "p1", "w1").title, "Theirs");
}

// ---- I delete, they leave alone → stays deleted ----------------------------
{
  const mine = edit((c) => { c.pages[0].widgets = c.pages[0].widgets.filter((x) => x.id !== "w2"); });
  const theirs = edit((c) => { c.version = 6; c.settings.title = "X"; });

  const r = merge(base(), mine, theirs);
  assert.equal(r.clean, true);
  assert.equal(r.config.pages[0].widgets.length, 1);
  assert.equal(w(r.config, "p1", "w2"), undefined);
}

// ---- I delete, they edit → conflict (never silently resurrect or drop) -----
{
  const mine = edit((c) => { c.pages[0].widgets = c.pages[0].widgets.filter((x) => x.id !== "w2"); });
  const theirs = edit((c) => { c.version = 6; w(c, "p1", "w2").title = "Still here"; });

  const r = merge(base(), mine, theirs);
  assert.equal(r.clean, false);
  const c = r.conflicts.find((x) => x.key === "widget:p1:w2");
  assert.ok(c);
  assert.equal(c.kind, "deleted-by-you-edited-by-them");
}

// ---- whole page add --------------------------------------------------------
{
  const mine = edit((c) => { c.pages.push({ id: "p3", name: "Garage", widgets: [] }); });
  const theirs = edit((c) => { c.version = 6; c.pages[1].name = "Weather radar"; });

  const r = merge(base(), mine, theirs);
  assert.equal(r.clean, true);
  assert.deepEqual(r.config.pages.map((p) => p.id), ["p1", "p2", "p3"]);
  assert.equal(r.config.pages[1].name, "Weather radar");
}

// ---- unmodelled top-level keys survive a merge -----------------------------
{
  const mine = edit((c) => { c.settings.title = "Mine"; });
  const theirs = edit((c) => { c.version = 6; c.someFutureField = { a: 1 }; });
  const r = merge(base(), mine, theirs);
  assert.deepEqual(r.config.someFutureField, { a: 1 },
    "a schema field this module doesn't know must not be dropped");
}

// ---- explicit resolution ---------------------------------------------------
{
  const mine = edit((c) => { w(c, "p1", "w1").title = "Mine"; });
  const theirs = edit((c) => { c.version = 6; w(c, "p1", "w1").title = "Theirs"; });

  const keepMine = resolve(base(), mine, theirs, new Map([["widget:p1:w1", "mine"]]));
  assert.equal(keepMine.clean, true);
  assert.equal(w(keepMine.config, "p1", "w1").title, "Mine");

  const takeTheirs = resolve(base(), mine, theirs, new Map([["widget:p1:w1", "theirs"]]));
  assert.equal(takeTheirs.clean, true);
  assert.equal(w(takeTheirs.config, "p1", "w1").title, "Theirs");

  const partial = resolve(base(), mine, theirs, new Map());
  assert.equal(partial.clean, false, "no choices leaves the conflict outstanding");
}

// ---- resolving a delete-vs-edit in my favour actually deletes --------------
{
  const mine = edit((c) => { c.pages[0].widgets = c.pages[0].widgets.filter((x) => x.id !== "w2"); });
  const theirs = edit((c) => { c.version = 6; w(c, "p1", "w2").title = "Still here"; });

  const r = resolve(base(), mine, theirs, new Map([
    ["widget:p1:w2", "mine"],
    ["widgetOrder:p1", "mine"],
  ]));
  assert.equal(r.clean, true);
  assert.equal(w(r.config, "p1", "w2"), undefined, "keeping my delete must remove the widget");
}

// ---- human labels ----------------------------------------------------------
{
  const cfg = base();
  assert.equal(describeKey("widget:p1:w2", cfg), "Widget: Weather");
  assert.equal(describeKey("page:p2", cfg), "Page: Radar");
  assert.equal(describeKey("settings.theme.accent", cfg), "Setting: theme.accent");
  assert.equal(describeKey("pageOrder", cfg), "Page order");
}

console.log("merge: ok");
