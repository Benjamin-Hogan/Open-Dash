// Node smoke tests for admin/js/model/layout.js — how the canvas makes room
// when a widget is dragged or resized onto its neighbours.
import assert from "node:assert/strict";
import { resolve, overlaps } from "../admin/js/model/layout.js";

const r = (id, x, y, w, h) => ({ id, x, y, w, h });
const at = (out, id) => { const g = out.get(id); return [g.x, g.y, g.w, g.h]; };
const noOverlaps = (out) => {
  const rs = [...out.values()];
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) assert.ok(!overlaps(rs[i], rs[j]), "layout overlaps");
};

// A full 2x2 screen of equal tiles: dragging one onto another swaps them.
{
  const items = [r("a", 0, 0, 6, 3), r("b", 6, 0, 6, 3), r("c", 0, 3, 6, 3), r("d", 6, 3, 6, 3)];
  const out = resolve(items, new Map([["a", { x: 6, y: 0, w: 6, h: 3 }]]), 12);
  assert.deepEqual(at(out, "a"), [6, 0, 6, 3]);
  assert.deepEqual(at(out, "b"), [0, 0, 6, 3]);
  assert.deepEqual(at(out, "c"), [0, 3, 6, 3]);
  noOverlaps(out);
  // Diagonal swap too.
  const out2 = resolve(items, new Map([["a", { x: 6, y: 3, w: 6, h: 3 }]]), 12);
  assert.deepEqual(at(out2, "d"), [0, 0, 6, 3]);
  noOverlaps(out2);
}

// Partial overlap of a full screen still lands, the covered tile swaps back.
{
  const items = [r("a", 0, 0, 4, 2), r("b", 4, 0, 4, 2), r("c", 8, 0, 4, 2)];
  const out = resolve(items, new Map([["a", { x: 3, y: 0, w: 4, h: 2 }]]), 12);
  assert.deepEqual(at(out, "a"), [3, 0, 4, 2]);
  noOverlaps(out);
}

// Different sizes: a small tile dropped on a big one pushes it down.
{
  const items = [r("a", 0, 0, 2, 2), r("big", 4, 0, 8, 4), r("below", 4, 4, 8, 2)];
  const out = resolve(items, new Map([["a", { x: 5, y: 1, w: 2, h: 2 }]]), 12);
  assert.deepEqual(at(out, "a"), [5, 1, 2, 2]);
  noOverlaps(out);
  // Anything that wasn't in the way stays exactly where it was relative order.
  assert.ok(out.get("below").y >= out.get("big").y + out.get("big").h);
}

// Nothing in the way: nothing else moves.
{
  const items = [r("a", 0, 0, 2, 2), r("b", 6, 0, 2, 2)];
  const out = resolve(items, new Map([["a", { x: 2, y: 3, w: 2, h: 2 }]]), 12);
  assert.deepEqual(at(out, "b"), [6, 0, 2, 2]);
}

// Resizing east slides the neighbour over when there's room...
{
  const items = [r("a", 0, 0, 4, 2), r("b", 4, 0, 4, 2)];
  const out = resolve(items, new Map([["a", { x: 0, y: 0, w: 6, h: 2 }]]), 12, { mode: "resize", dir: "e" });
  assert.deepEqual(at(out, "b"), [6, 0, 4, 2]);
  noOverlaps(out);
}
// ...and pushes it down when there isn't.
{
  const items = [r("a", 0, 0, 6, 2), r("b", 6, 0, 6, 2), r("c", 0, 2, 12, 2)];
  const out = resolve(items, new Map([["a", { x: 0, y: 0, w: 8, h: 2 }]]), 12, { mode: "resize", dir: "e" });
  assert.deepEqual(at(out, "a"), [0, 0, 8, 2]);
  assert.deepEqual(at(out, "b"), [6, 2, 6, 2]);
  assert.deepEqual(at(out, "c"), [0, 4, 12, 2]);
  noOverlaps(out);
}

// Resizing south pushes what's below down, cascading.
{
  const items = [r("a", 0, 0, 12, 2), r("b", 0, 2, 12, 2), r("c", 0, 4, 12, 2)];
  const out = resolve(items, new Map([["a", { x: 0, y: 0, w: 12, h: 3 }]]), 12, { mode: "resize", dir: "s" });
  assert.deepEqual(at(out, "b"), [0, 3, 12, 2]);
  assert.deepEqual(at(out, "c"), [0, 5, 12, 2]);
}

// A multi-selection moves as a group and the covered tiles trade places with it.
{
  const items = [r("a", 0, 0, 3, 2), r("b", 3, 0, 3, 2), r("c", 6, 0, 3, 2), r("d", 9, 0, 3, 2)];
  const moved = new Map([["a", { x: 6, y: 0, w: 3, h: 2 }], ["b", { x: 9, y: 0, w: 3, h: 2 }]]);
  const out = resolve(items, moved, 12);
  assert.deepEqual(at(out, "c"), [0, 0, 3, 2]);
  assert.deepEqual(at(out, "d"), [3, 0, 3, 2]);
  noOverlaps(out);
}

console.log("layout: ok");

// A neighbour that can't trade places steps aside before being pushed down.
{
  const items = [r("a", 0, 0, 2, 2), r("b", 4, 0, 4, 2), r("wide", 0, 2, 12, 2)];
  // a dragged onto b's right half: b can't go to (0,0) without... it can, it's
  // free once a leaves; corner swap wins.
  const out = resolve(items, new Map([["a", { x: 6, y: 0, w: 2, h: 2 }]]), 12);
  assert.deepEqual(at(out, "b"), [0, 0, 4, 2]);
  assert.deepEqual(at(out, "wide"), [0, 2, 12, 2]);
  noOverlaps(out);
}
{
  // a's old spot is too small for b (blocked by c), so b slides left of a.
  const items = [r("c", 2, 0, 2, 2), r("a", 0, 0, 2, 2), r("b", 6, 0, 4, 2)];
  const out = resolve(items, new Map([["a", { x: 9, y: 0, w: 2, h: 2 }]]), 12);
  assert.deepEqual(at(out, "a"), [9, 0, 2, 2]);
  assert.deepEqual(at(out, "b"), [5, 0, 4, 2]);
  assert.deepEqual(at(out, "c"), [2, 0, 2, 2]);
  noOverlaps(out);
}
console.log("layout (aside): ok");
