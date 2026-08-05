// One field descriptor for every form in the admin.
//
// Before this, plugin `settings` fields went through a small dispatcher while
// every structural field (title, grid, schedule, variants, slides) was
// hand-built, and both read their values back by scraping the DOM for
// `data-name="set-url"` / `data-name="ss-3-set-apiKey"` strings. That string
// protocol is the direct cause of three slide bugs: values landing on the wrong
// slide after a reorder, stock symbols never being written back, and a slide's
// unrendered keys being dropped on save.
//
// Here both kinds of field normalise to the same shape and address a real
// object draft by dotted path, so there is nothing to scrape and nothing to
// re-key when a list is reordered.
//
// DOM-free — see core/clone.js.

/**
 * @typedef {object} FieldDef
 * @property {string}  key         dotted path into the draft ("settings.url")
 * @property {string}  label
 * @property {string} [help]       one line under the control
 * @property {string}  type        text|textarea|number|boolean|select|password|
 *                                 color|time|date|note|grid|list|group|custom
 * @property {*}      [default]
 * @property {Array}  [options]    select: ["a"] or [{value,label}]
 * @property {boolean}[required]   blocks save and marks the field
 * @property {string} [group]      renders inside a collapsible fieldset
 * @property {number} [min],[max],[step]
 * @property {(draft:object)=>boolean} [when]  conditional visibility
 * @property {FieldDef[]} [fields]      group/composite children
 * @property {FieldDef[]} [itemFields]  list item children
 * @property {Function}   [render]      custom: (ctx) => Node
 */

/** Plugin field types the renderer delegates to bespoke widgets. */
export const CUSTOM_WIDGET_TYPES = new Set(["stock-picker", "url-presets", "embed-presets"]);

/** Types that never hold a value. */
export const VALUELESS = new Set(["note", "custom-display"]);

/**
 * Turn a plugin's `schema.fields` into FieldDefs addressing `<prefix>.<key>`.
 * `required` and `group` are carried through — until now nothing read either,
 * so `required: true` on iframe.url was decorative and the three `group:"embed"`
 * fields on iframe never grouped anything.
 */
export function fromPluginSchema(fields = [], prefix = "settings") {
  return fields.map((f) => ({
    ...f,
    key: `${prefix}.${f.key}`,
    // The plugin's own key, kept for custom renderers that need the bare name.
    settingKey: f.key,
    type: f.type || "text",
  }));
}

/** Apply defaults for anything the draft doesn't already define. */
export function applyDefaults(defs, draft, get, set) {
  for (const f of defs) {
    if (VALUELESS.has(f.type) || f.default === undefined) continue;
    if (get(draft, f.key) === undefined) set(draft, f.key, f.default);
  }
  return draft;
}

/** Only the fields whose `when` predicate passes for this draft. */
export function visible(defs, draft) {
  return defs.filter((f) => typeof f.when !== "function" || f.when(draft));
}

/**
 * Partition into ordered [{ group, fields }]. Ungrouped fields keep their
 * position; the first field of each group marks where that group renders.
 */
export function byGroup(defs) {
  const out = [];
  const groups = new Map();
  for (const f of defs) {
    if (!f.group) { out.push({ group: null, fields: [f] }); continue; }
    if (!groups.has(f.group)) {
      const entry = { group: f.group, fields: [] };
      groups.set(f.group, entry);
      out.push(entry);
    }
    groups.get(f.group).fields.push(f);
  }
  return out;
}

/** Human label for a group key ("embed" -> "Embed & security"). */
export const GROUP_LABEL = {
  embed: "Embed & security",
  advanced: "Advanced",
  cache: "Caching",
};

export function groupLabel(key) {
  return GROUP_LABEL[key] || key.charAt(0).toUpperCase() + key.slice(1);
}
