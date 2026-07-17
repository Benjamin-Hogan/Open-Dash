// Node smoke tests for web/js/scenes.js schedule evaluation.
import assert from "node:assert/strict";
import { inWindow, scheduleWindows, scheduleParts } from "../web/js/scenes.js";

function atLocal(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

// Legacy single window still works.
{
  const s = { enabled: true, start: "09:00", end: "17:00", days: [0, 1, 2, 3, 4] }; // Mon–Fri
  // 2026-07-17 is a Friday (dow=4)
  assert.equal(inWindow(s, atLocal(2026, 7, 17, 10, 0)), true);
  assert.equal(inWindow(s, atLocal(2026, 7, 17, 8, 0)), false);
  assert.equal(inWindow(s, atLocal(2026, 7, 18, 10, 0)), false); // Sat
}

// Multi-window OR.
{
  const s = {
    enabled: true,
    windows: [
      { start: "07:00", end: "09:00", days: [0, 1, 2, 3, 4] },
      { start: "17:00", end: "19:00", days: [0, 1, 2, 3, 4] },
    ],
  };
  assert.equal(inWindow(s, atLocal(2026, 7, 17, 8, 0)), true);
  assert.equal(inWindow(s, atLocal(2026, 7, 17, 12, 0)), false);
  assert.equal(inWindow(s, atLocal(2026, 7, 17, 18, 0)), true);
}

// Date range gate.
{
  const s = {
    enabled: true,
    start: "00:00",
    end: "23:59",
    dateFrom: "2026-07-01",
    dateTo: "2026-07-31",
  };
  assert.equal(inWindow(s, atLocal(2026, 7, 15, 12, 0)), true);
  assert.equal(inWindow(s, atLocal(2026, 6, 15, 12, 0)), false);
  assert.equal(inWindow(s, atLocal(2026, 8, 1, 12, 0)), false);
}

// Disabled schedule always visible.
assert.equal(inWindow({ enabled: false, start: "09:00", end: "10:00" }, atLocal(2026, 7, 17, 12, 0)), true);

// windowsOf legacy fallback.
assert.deepEqual(scheduleWindows({ start: "01:00", end: "02:00", days: [6] }), [
  { start: "01:00", end: "02:00", days: [6] },
]);

// scheduleParts local.
{
  const p = scheduleParts(atLocal(2026, 7, 17, 15, 30));
  assert.equal(p.ymd, "2026-07-17");
  assert.equal(p.minutes, 15 * 60 + 30);
  assert.equal(p.dow, 4); // Friday
}

console.log("ok — schedule js tests passed");
