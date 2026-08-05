// Deep clone + structural equality. DOM-free on purpose: this module and
// everything under core/ and model/ must run under plain `node` so the store,
// the merge and the ordering rules are testable without a browser.

// structuredClone handles everything a config can hold (plain objects, arrays,
// strings, numbers, booleans, null). It is not a JSON round-trip: undefined
// values and key order survive, which matters when we diff against the server's
// response. Node has had it globally since 17.
export function clone(value) {
  return structuredClone(value);
}

// Order-sensitive for arrays (widget order *is* meaningful), order-insensitive
// for object keys (the server may serialise them differently than we sent them).
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") {
    // NaN !== NaN, but two configs that both hold NaN are not "changed".
    return Number.isNaN(a) && Number.isNaN(b);
  }

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;

  if (aIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.hasOwn(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

// Read/write a dotted path ("settings.theme.accent", "pages.0.name"). The form
// engine addresses every field this way, which is also what lets a 422's
// `loc` tuple be turned straight into a field to focus.
export function getPath(obj, path) {
  let cur = obj;
  for (const part of String(path).split(".")) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setPath(obj, path, value) {
  const parts = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cur[part] == null || typeof cur[part] !== "object") {
      // Numeric next segment means the missing container is an array.
      cur[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[part];
  }
  cur[parts.at(-1)] = value;
  return obj;
}
