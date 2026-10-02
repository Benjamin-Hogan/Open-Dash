// Grid layout resolution for the canvas: where everything else goes when a
// widget is dragged or resized onto its neighbours.
//
// The canvas used to refuse any overlap, so on a full page nothing could move
// at all. Now the moved widget always lands where it's dropped and the
// widgets it covers get out of the way: a swap into the space it left when
// they fit there, otherwise a push (sideways for a sideways resize, else
// down). Pure functions over plain {x, y, w, h} rects so it's testable in
// Node and the same rules serve drags and keyboard nudges.

export function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

const within = (r, cols) => r.x >= 0 && r.y >= 0 && r.x + r.w <= cols;

/**
 * Resolve a layout after some widgets were moved or resized.
 *
 * @param {Array<{id, x, y, w, h}>} items  every widget's rect BEFORE the gesture
 * @param {Map<string, {x, y, w, h}>} moved  the new rects of the widgets being dragged
 * @param {number} cols  grid width
 * @param {object} [opts]
 * @param {"move"|"resize"} [opts.mode="move"]
 * @param {string} [opts.dir]  resize handle ("e", "sw", ...)
 * @returns {Map<string, {x, y, w, h}>} the new rect for every widget
 */
export function resolve(items, moved, cols, opts = {}) {
  const mode = opts.mode || "move";
  const out = new Map(items.map((it) => [it.id, pick(moved.get(it.id) || it)]));
  const orig = new Map(items.map((it) => [it.id, pick(it)]));
  const fixedIds = new Set(moved.keys());
  const others = items.filter((it) => !fixedIds.has(it.id));
  const fixed = [...fixedIds].map((id) => out.get(id)).filter(Boolean);

  const hits = others.filter((o) => fixed.some((f) => overlaps(f, o)));
  if (!hits.length) return out;

  const free = (r, skip) => {
    for (const [id, other] of out) if (!skip.has(id) && overlaps(r, other)) return false;
    return within(r, cols);
  };

  // 1. Swap: a move whose covered widgets all fit, together, in the space the
  //    moved widget(s) left. Dragging a tile onto a neighbour just trades them.
  if (mode === "move") {
    const tryShift = (dx, dy) => {
      const next = hits.map((h) => ({ id: h.id, ...h, x: h.x + dx, y: h.y + dy }));
      const skip = new Set(hits.map((h) => h.id));
      const ok = next.every((r) => free(r, skip));
      if (ok) for (const r of next) out.set(r.id, pick(r));
      return ok;
    };
    if (fixed.length) {
      // Same offset as the drag, reversed, keeps the hits' arrangement intact.
      const lead = [...fixedIds][0];
      const dx = orig.get(lead).x - out.get(lead).x;
      const dy = orig.get(lead).y - out.get(lead).y;
      if (tryShift(dx, dy)) return out;
      // A single neighbour of a different size: put its corner where the
      // moved widget's corner was, else step it aside (left, right, above),
      // nearest first. Only when none of that fits does it get pushed down.
      if (hits.length === 1 && fixedIds.size === 1) {
        const h = hits[0], o = orig.get(lead), f = out.get(lead);
        const aside = [
          { x: f.x - h.w, y: h.y },
          { x: f.x + f.w, y: h.y },
          { x: h.x, y: f.y - h.h },
        ].sort((a, b) => dist(a, h) - dist(b, h));
        for (const sp of [{ x: Math.min(o.x, cols - h.w), y: o.y }, ...aside]) {
          if (tryShift(sp.x - h.x, sp.y - h.y)) return out;
        }
      }
    }
  }

  // 2. Sideways resize: slide the covered widgets over if there's room.
  if (mode === "resize" && opts.dir && !/[ns]/.test(opts.dir)) {
    const f = fixed[0];
    const east = opts.dir.includes("e");
    const next = hits.map((h) => ({
      ...h, x: east ? Math.max(h.x, f.x + f.w) : Math.min(h.x, f.x - h.w),
    }));
    // Each hit only shifts as far as it needs to, then must sit somewhere free.
    const skip = new Set(hits.map((h) => h.id));
    if (next.every((r) => free(r, skip)) && !overlapsAny(next)) {
      for (const r of next) out.set(r.id, pick(r));
      return out;
    }
  }

  // 3. Push down: walk the rest top to bottom and drop each one just below
  //    whatever it lands on. Widgets that weren't in the way never move.
  const placed = [...fixed];
  const order = [...others].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const it of order) {
    const r = pick(it);
    let hit;
    while ((hit = placed.find((p) => overlaps(p, r)))) r.y = hit.y + hit.h;
    out.set(it.id, r);
    placed.push(r);
  }
  return out;
}

function overlapsAny(rects) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) if (overlaps(rects[i], rects[j])) return true;
  }
  return false;
}

const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function pick(r) { return { x: r.x, y: r.y, w: r.w, h: r.h }; }
