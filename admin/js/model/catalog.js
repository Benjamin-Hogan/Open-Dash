// What the dashboard can actually do, as data.
//
// Every plugin already declares meta.label, meta.description and meta.category,
// and none of it reached the UI — the picker was a flat <select> of raw type
// keys, so you chose between strings like "air-quality", "heads-up" and
// "space-imagery" with no hint what any of them were.
//
// DOM-free — see core/clone.js.

import * as registry from "/widgets/index.js";

export const CATEGORY_ORDER = ["basic", "data", "embed", "system", "container", "other"];

export const CATEGORY_LABEL = {
  basic: "Basics",
  data: "Live data",
  embed: "Embeds & media",
  system: "This machine",
  container: "Containers",
  other: "Other",
};

/** Widget types whose data needs a global API key, and which key. */
const KEY_HINTS = {
  stocks: "FINNHUB_API_KEY",
  "youtube-live": "YOUTUBE_API_KEY",
};

export function catalog() {
  return registry.manifest().map(({ type, meta, schema }) => {
    const fields = schema?.fields || [];
    return {
      type,
      label: meta?.label || type,
      description: meta?.description || "",
      category: meta?.category || "other",
      requiredKeys: fields.filter((f) => f.required).map((f) => f.key),
      // A per-widget password field (OctoPrint) or a global key (Finnhub).
      needsWidgetSecret: fields.some((f) => f.type === "password"),
      needsGlobalKey: KEY_HINTS[type] || null,
      fieldCount: fields.filter((f) => f.type !== "note").length,
    };
  });
}

/** Catalog grouped into [{ category, label, items }] in display order. */
export function grouped(items = catalog()) {
  const byCat = new Map();
  for (const it of items) {
    if (!byCat.has(it.category)) byCat.set(it.category, []);
    byCat.get(it.category).push(it);
  }
  const order = [...CATEGORY_ORDER, ...[...byCat.keys()].filter((c) => !CATEGORY_ORDER.includes(c))];
  return order
    .filter((c) => byCat.has(c))
    .map((c) => ({
      category: c,
      label: CATEGORY_LABEL[c] || c,
      items: byCat.get(c).sort((a, b) => a.label.localeCompare(b.label)),
    }));
}

/**
 * Substring search over label, description and type.
 * Ranked so a label prefix beats a description mention — typing "we" should
 * offer Weather before "shows the current weather" matches on something else.
 */
export function search(query, items = catalog()) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return items;
  const scored = [];
  for (const it of items) {
    const label = it.label.toLowerCase();
    const type = it.type.toLowerCase();
    const desc = it.description.toLowerCase();
    let score = 0;
    if (label.startsWith(q) || type.startsWith(q)) score = 3;
    else if (label.includes(q) || type.includes(q)) score = 2;
    else if (desc.includes(q)) score = 1;
    if (score) scored.push({ it, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.it.label.localeCompare(b.it.label))
    .map((s) => s.it);
}

/** Default settings for a new widget of this type.
 *  The old form displayed each field's `default` but only wrote what was in the
 *  DOM, so defaults were decorative — a widget added and saved untouched came
 *  out with an empty settings bag. */
export function defaultSettings(type) {
  const plugin = registry.get(type);
  const out = {};
  for (const f of plugin?.schema?.fields || []) {
    if (f.type === "note" || f.default === undefined) continue;
    out[f.key] = f.default;
  }
  return out;
}
