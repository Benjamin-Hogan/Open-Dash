// One page order.
//
// The admin used to have two: the page bar's ←/→ reordered `pages[]`, while the
// rotation panel's ↑↓ reordered `rotation.order`, with bespoke swap-sync code
// trying to hold them together and a note in the UI explaining the difference.
// Now the page bar is the sole reorder surface and `rotation.order` is derived.
//
// The schema already treats an empty `rotation.order` as "natural page order",
// so the derived form is simply `[]` — no redundant list to drift out of sync.
//
// DOM-free — see core/clone.js.

/** The pages rotation will actually cycle, in order. */
export function rotationPages(cfg) {
  const pages = cfg?.pages || [];
  const order = cfg?.rotation?.order;
  if (!Array.isArray(order) || !order.length) return [...pages];

  // Legacy explicit order: honour it, but only for pages that still exist, and
  // append anything it never mentioned so a page can't silently stop rotating.
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out = [];
  for (const id of order) {
    const p = byId.get(id);
    if (p && !out.includes(p)) out.push(p);
  }
  for (const p of pages) if (!out.includes(p)) out.push(p);
  return out;
}

/** True when `rotation.order` says something the page order doesn't. */
export function hasCustomOrder(cfg) {
  const order = cfg?.rotation?.order;
  if (!Array.isArray(order) || !order.length) return false;
  const natural = (cfg?.pages || []).map((p) => p.id);
  return order.length !== natural.length || order.some((id, i) => id !== natural[i]);
}

/**
 * Collapse `rotation.order` to the derived form. Mutates in place.
 * Called after any page add / delete / reorder, and once on load, so a legacy
 * custom order is flattened the first time the config is saved.
 */
export function syncRotationOrder(cfg) {
  const r = cfg?.rotation;
  if (!r || !Array.isArray(r.order) || !r.order.length) return false;
  r.order = [];
  return true;
}
