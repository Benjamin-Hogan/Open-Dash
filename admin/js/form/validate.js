// Client-side validation, plus mapping the server's 422 onto the same shape.
//
// Errors are anchored to a field path so the form can mark the offending
// control and scroll to it. The old admin surfaced a 422 as
// `JSON.stringify(detail[0].msg)` in a toast that vanished after three seconds
// — raw Pydantic prose with no indication of which field it meant.
//
// DOM-free — see core/clone.js.

import { getPath } from "../core/clone.js";
import { visible, VALUELESS } from "./schema.js";

const isBlank = (v) =>
  v === undefined || v === null || v === "" ||
  (Array.isArray(v) && v.length === 0);

/**
 * @returns {Array<{path:string, message:string}>} empty when the draft is valid
 */
export function validate(defs, draft) {
  const errors = [];
  for (const f of visible(defs, draft)) {
    if (VALUELESS.has(f.type)) continue;
    const value = getPath(draft, f.key);

    if (f.required && isBlank(value)) {
      errors.push({ path: f.key, message: `${f.label} is required` });
      continue;
    }
    if (isBlank(value)) continue;

    if (f.type === "number") {
      const n = Number(value);
      if (Number.isNaN(n)) {
        errors.push({ path: f.key, message: `${f.label} must be a number` });
      } else if (f.min !== undefined && n < f.min) {
        errors.push({ path: f.key, message: `${f.label} must be at least ${f.min}` });
      } else if (f.max !== undefined && n > f.max) {
        errors.push({ path: f.key, message: `${f.label} must be at most ${f.max}` });
      }
    }

    if (f.pattern && !new RegExp(f.pattern).test(String(value))) {
      errors.push({ path: f.key, message: f.patternMessage || `${f.label} is not in the expected format` });
    }

    // Recurse into list items so a bad slide reports against that slide.
    if (f.type === "list" && Array.isArray(value)) {
      value.forEach((_item, i) => {
        const itemDefs = (typeof f.itemFields === "function" ? f.itemFields(value[i], i) : f.itemFields) || [];
        const scoped = itemDefs.map((d) => ({ ...d, key: `${f.key}.${i}.${d.key}` }));
        errors.push(...validate(scoped, draft));
      });
    }
  }
  return errors;
}

/**
 * Map a Pydantic 422 `detail` array onto field paths.
 *
 * `loc` arrives as ["body","pages",0,"widgets",1,"grid","w"]. The admin's forms
 * address a single widget, so a config-level path is trimmed to the part the
 * open form actually owns when `scope` is supplied.
 *
 * @param scope e.g. "pages.0.widgets.1" — stripped from the front of each path
 */
export function fromServer(detail, scope = "") {
  if (!Array.isArray(detail)) return [];
  return detail.map((d) => {
    let path = (d.loc || []).filter((p) => p !== "body").join(".");
    if (scope && path.startsWith(scope + ".")) path = path.slice(scope.length + 1);
    return { path, message: d.msg || String(d), serverPath: (d.loc || []).join(".") };
  });
}

/** Index errors by path for quick lookup while rendering. */
export function byPath(errors) {
  const map = new Map();
  for (const e of errors) {
    if (!map.has(e.path)) map.set(e.path, []);
    map.get(e.path).push(e.message);
  }
  return map;
}
