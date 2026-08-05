// Node smoke tests for the form engine's DOM-free half:
// admin/js/form/schema.js and admin/js/form/validate.js.
import assert from "node:assert/strict";
import {
  fromPluginSchema, applyDefaults, visible, byGroup, groupLabel,
} from "../admin/js/form/schema.js";
import { validate, fromServer, byPath } from "../admin/js/form/validate.js";
import { getPath, setPath } from "../admin/js/core/clone.js";

// ---- plugin schema -> FieldDef ---------------------------------------------
{
  const defs = fromPluginSchema([
    { key: "url", label: "URL", type: "url-presets", required: true },
    { key: "disableSandbox", label: "Disable sandbox", type: "boolean", default: false, group: "embed" },
  ]);
  assert.deepEqual(defs.map((d) => d.key), ["settings.url", "settings.disableSandbox"],
    "keys are prefixed into the settings bag");
  assert.equal(defs[0].required, true, "required survives — nothing read it before");
  assert.equal(defs[1].group, "embed", "group survives — nothing read it before");
  assert.equal(defs[1].settingKey, "disableSandbox", "the bare plugin key is kept");
}

// ---- defaults are materialised ---------------------------------------------
{
  // The old form displayed each field's default but only wrote what was in the
  // DOM, so a widget added and saved untouched had an empty settings bag.
  const defs = fromPluginSchema([
    { key: "units", type: "select", default: "imperial" },
    { key: "showForecast", type: "boolean", default: true },
    { key: "lat", type: "number" },
    { key: "_note", type: "note", label: "hi" },
  ]);
  const draft = { settings: {} };
  applyDefaults(defs, draft, getPath, setPath);
  assert.deepEqual(draft.settings, { units: "imperial", showForecast: true },
    "defaults land; a field without one, and notes, do not");

  const kept = { settings: { units: "metric" } };
  applyDefaults(defs, kept, getPath, setPath);
  assert.equal(kept.settings.units, "metric", "an existing value is never overwritten");
}

// ---- conditional visibility -------------------------------------------------
{
  const defs = [
    { key: "a", type: "text" },
    { key: "b", type: "text", when: (d) => d.a === "show" },
  ];
  assert.deepEqual(visible(defs, { a: "no" }).map((f) => f.key), ["a"]);
  assert.deepEqual(visible(defs, { a: "show" }).map((f) => f.key), ["a", "b"]);
}

// ---- grouping ---------------------------------------------------------------
{
  const chunks = byGroup([
    { key: "url", type: "text" },
    { key: "sandbox", type: "boolean", group: "embed" },
    { key: "title", type: "text" },
    { key: "allow", type: "text", group: "embed" },
  ]);
  assert.deepEqual(chunks.map((c) => c.group), [null, "embed", null],
    "grouped fields collapse to one chunk at the first occurrence");
  assert.deepEqual(chunks[1].fields.map((f) => f.key), ["sandbox", "allow"]);
  assert.equal(groupLabel("embed"), "Embed & security");
  assert.equal(groupLabel("weird"), "Weird", "an unknown group still gets a readable label");
}

// ---- required ---------------------------------------------------------------
{
  const defs = [
    { key: "settings.url", label: "URL", type: "text", required: true },
    { key: "settings.count", label: "Count", type: "number", min: 1, max: 50 },
  ];
  assert.deepEqual(validate(defs, { settings: { url: "", count: 5 } }).map((e) => e.path),
    ["settings.url"], "blank required field is an error");
  assert.equal(validate(defs, { settings: { url: "x", count: 5 } }).length, 0);

  assert.deepEqual(validate(defs, { settings: { url: "x", count: 0 } })[0].message,
    "Count must be at least 1");
  assert.deepEqual(validate(defs, { settings: { url: "x", count: 99 } })[0].message,
    "Count must be at most 50");
  assert.equal(validate(defs, { settings: { url: "x", count: null } }).length, 0,
    "an optional blank is fine — null means inherit");

  // An empty array counts as blank, which is what a stock-picker with no
  // symbols actually is.
  const arr = [{ key: "settings.symbols", label: "Symbols", type: "stock-picker", required: true }];
  assert.equal(validate(arr, { settings: { symbols: [] } }).length, 1);
  assert.equal(validate(arr, { settings: { symbols: ["AAPL"] } }).length, 0);
}

// ---- hidden fields are not validated ---------------------------------------
{
  const defs = [
    { key: "mode", type: "text" },
    { key: "url", label: "URL", type: "text", required: true, when: (d) => d.mode === "web" },
  ];
  assert.equal(validate(defs, { mode: "local", url: "" }).length, 0,
    "a required field that isn't shown must not block save");
  assert.equal(validate(defs, { mode: "web", url: "" }).length, 1);
}

// ---- list items validate against their own index ---------------------------
{
  const defs = [{
    key: "slideshow.slides",
    label: "Slides",
    type: "list",
    itemFields: [{ key: "settings.url", label: "URL", type: "text", required: true }],
  }];
  const draft = {
    slideshow: {
      slides: [
        { settings: { url: "https://ok" } },
        { settings: { url: "" } },
      ],
    },
  };
  const errs = validate(defs, draft);
  assert.deepEqual(errs.map((e) => e.path), ["slideshow.slides.1.settings.url"],
    "the error points at the offending slide, not the list");
}

// ---- server 422 mapping -----------------------------------------------------
{
  const detail = [
    { loc: ["body", "settings", "columns"], msg: "Input should be less than or equal to 48" },
    { loc: ["body", "pages", 0, "widgets", 1, "grid", "w"], msg: "Input should be greater than 0" },
  ];
  const errs = fromServer(detail);
  assert.deepEqual(errs.map((e) => e.path),
    ["settings.columns", "pages.0.widgets.1.grid.w"],
    "the `body` marker is dropped and loc becomes a dotted path");

  // Scoped to the widget a form actually owns.
  const scoped = fromServer(detail, "pages.0.widgets.1");
  assert.equal(scoped[1].path, "grid.w", "the widget form sees its own field path");
  assert.equal(scoped[0].path, "settings.columns", "an out-of-scope path is left alone");
  assert.equal(scoped[1].serverPath, "body.pages.0.widgets.1.grid.w", "the original is kept");
}

// ---- error indexing ---------------------------------------------------------
{
  const map = byPath([
    { path: "a", message: "one" },
    { path: "a", message: "two" },
    { path: "b", message: "three" },
  ]);
  assert.deepEqual(map.get("a"), ["one", "two"]);
  assert.deepEqual(map.get("b"), ["three"]);
}

console.log("form: ok");
