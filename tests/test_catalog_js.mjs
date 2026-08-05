// Node smoke tests for admin/js/model/catalog.js.
//
// catalog.js imports the widget registry from "/widgets/index.js", an absolute
// URL the browser resolves against the admin origin. Node can't, so stub the
// registry with a tiny in-memory one before importing the module under test.
import assert from "node:assert/strict";
import { register } from "node:module";

// Minimal loader hook: redirect "/widgets/index.js" to a fixture module.
const STUB = new URL("./fixtures/registry-stub.mjs", import.meta.url).href;
register(
  "data:text/javascript," + encodeURIComponent(`
    export function resolve(spec, ctx, next) {
      if (spec === ${JSON.stringify("/widgets/index.js")}) return next(${JSON.stringify(STUB)}, ctx);
      return next(spec, ctx);
    }
  `),
  import.meta.url,
);

const { catalog, grouped, search, defaultSettings, CATEGORY_ORDER } =
  await import("../admin/js/model/catalog.js");

// ---- catalog shape ---------------------------------------------------------
{
  const items = catalog();
  assert.equal(items.length, 5);
  const weather = items.find((i) => i.type === "weather");
  assert.equal(weather.label, "Weather");
  assert.equal(weather.category, "data");
  assert.ok(weather.description.length, "description carries through");
  assert.deepEqual(weather.requiredKeys, [], "no required fields on weather");
  assert.equal(weather.fieldCount, 2, "note fields don't count as settings");

  const iframe = items.find((i) => i.type === "iframe");
  assert.deepEqual(iframe.requiredKeys, ["url"], "required metadata is read");

  const octo = items.find((i) => i.type === "octoprint");
  assert.equal(octo.needsWidgetSecret, true, "a password field is a secret");

  const stocks = items.find((i) => i.type === "stocks");
  assert.equal(stocks.needsGlobalKey, "FINNHUB_API_KEY");
  assert.equal(weather.needsGlobalKey, null);
}

// ---- grouping --------------------------------------------------------------
{
  const groups = grouped();
  const cats = groups.map((g) => g.category);
  // Declared order is honoured, and unknown categories are appended not dropped.
  const expected = CATEGORY_ORDER.filter((c) => cats.includes(c));
  assert.deepEqual(cats.filter((c) => CATEGORY_ORDER.includes(c)), expected);
  assert.ok(cats.includes("mystery"), "an unknown category still appears");
  assert.equal(groups.at(-1).category, "mystery", "unknown categories go last");

  const data = groups.find((g) => g.category === "data");
  assert.deepEqual(data.items.map((i) => i.label), ["OctoPrint", "Stocks", "Weather"],
    "items sort by label inside a group");
  assert.equal(data.label, "Live data", "categories get a human label");
  assert.equal(groups.find((g) => g.category === "mystery").label, "mystery",
    "an unlabelled category falls back to its key");
}

// ---- search ----------------------------------------------------------------
{
  assert.equal(search("").length, 5, "empty query returns everything");
  assert.deepEqual(search("weather").map((i) => i.type), ["weather"]);
  assert.deepEqual(search("WEATHER").map((i) => i.type), ["weather"], "case insensitive");

  // Matches the raw type key too, which is what someone reading a config sees.
  assert.deepEqual(search("octoprint").map((i) => i.type), ["octoprint"]);

  // Ranking: label prefix (3) > label substring (2) > description only (1).
  // "c" starts Clock, sits inside OctoPrint, and appears in two descriptions.
  const c = search("c").map((i) => i.type);
  assert.equal(c[0], "clock", "a label prefix ranks first");
  assert.equal(c[1], "octoprint", "a label substring outranks a description hit");
  assert.deepEqual(c.slice(2).sort(), ["stocks", "weather"], "description-only matches come last");

  assert.deepEqual(search("zzzz"), [], "no match is empty, not everything");
}

// ---- defaults --------------------------------------------------------------
{
  const d = defaultSettings("weather");
  assert.deepEqual(d, { units: "imperial", showForecast: true },
    "every field default is materialised");
  assert.ok(!("_note" in defaultSettings("stocks")), "notes never become settings");
  assert.deepEqual(defaultSettings("nope"), {}, "unknown type yields an empty bag");
}

console.log("catalog: ok");
