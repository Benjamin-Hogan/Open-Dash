// Node smoke tests for admin/js/model/schedule.js — the legacy/multi-window
// normalisation that used to live inside gatherSchedule(), reading the DOM.
import assert from "node:assert/strict";
import { toDraft, fromDraft, isEmpty, describe } from "../admin/js/model/schedule.js";

// ---- toDraft: one representation in, one out -------------------------------
{
  // Legacy flat shape.
  const d = toDraft({ enabled: true, start: "09:00", end: "17:00", days: [0, 1, 2, 3, 4] });
  assert.equal(d.enabled, true);
  assert.equal(d.windows.length, 1);
  assert.deepEqual(d.windows[0], { start: "09:00", end: "17:00", days: [0, 1, 2, 3, 4] });

  // Multi-window shape wins when both are somehow present.
  const multi = toDraft({
    enabled: true,
    start: "09:00", end: "17:00", days: [0],
    windows: [{ start: "07:00", end: "09:00", days: [1] }],
  });
  assert.equal(multi.windows.length, 1);
  assert.equal(multi.windows[0].start, "07:00", "the windows array is authoritative");

  // Nothing at all still yields one editable blank window.
  const blank = toDraft(null);
  assert.deepEqual(blank.windows, [{ start: null, end: null, days: [] }]);
  assert.equal(blank.enabled, false);

  // The draft must not alias the stored object.
  const src = { enabled: true, windows: [{ start: "07:00", end: "09:00", days: [1, 2] }] };
  const copy = toDraft(src);
  copy.windows[0].days.push(5);
  assert.deepEqual(src.windows[0].days, [1, 2], "editing the draft must not touch the config");
}

// ---- isEmpty ----------------------------------------------------------------
{
  assert.equal(isEmpty(toDraft(null)), true);
  assert.equal(isEmpty(toDraft({ start: "09:00" })), false);
  assert.equal(isEmpty(toDraft({ timeZone: "America/Phoenix" })), false);
  assert.equal(isEmpty(toDraft({ dateFrom: "2026-01-01" })), false);
}

// ---- fromDraft: nothing to store -------------------------------------------
{
  assert.equal(fromDraft(toDraft(null)), null, "an untouched schedule stays null");
  // Enabling with no bounds is still meaningful — it means "always".
  const always = fromDraft({ ...toDraft(null), enabled: true });
  assert.ok(always);
  assert.equal(always.enabled, true);
}

// ---- fromDraft: the simple case stays simple -------------------------------
{
  const out = fromDraft({
    enabled: true, timeZone: "", dateFrom: "", dateTo: "",
    windows: [{ start: "09:00", end: "17:00", days: [4, 0, 2] }],
  });
  assert.equal(out.start, "09:00");
  assert.equal(out.end, "17:00");
  assert.deepEqual(out.days, [0, 2, 4], "days are sorted");
  assert.deepEqual(out.windows, [], "no redundant one-entry windows array");
  assert.equal(out.timeZone, null);
}

// ---- fromDraft: anything richer uses the windows array ---------------------
{
  const two = fromDraft({
    enabled: true, timeZone: "", dateFrom: "", dateTo: "",
    windows: [
      { start: "07:00", end: "09:00", days: [0, 1, 2, 3, 4] },
      { start: "17:00", end: "19:00", days: [0, 1, 2, 3, 4] },
    ],
  });
  assert.equal(two.windows.length, 2);
  assert.equal(two.start, null, "the flat fields are cleared when windows are used");

  // A timezone alone forces the richer shape even with one window.
  const tz = fromDraft({
    enabled: true, timeZone: "America/Phoenix", dateFrom: "", dateTo: "",
    windows: [{ start: "09:00", end: "17:00", days: [] }],
  });
  assert.equal(tz.timeZone, "America/Phoenix");
  assert.equal(tz.windows.length, 1);
  assert.equal(tz.start, null);
}

// ---- fromDraft drops blank windows -----------------------------------------
{
  const out = fromDraft({
    enabled: true, timeZone: "", dateFrom: "", dateTo: "",
    windows: [
      { start: "09:00", end: "17:00", days: [] },
      { start: null, end: null, days: [] },   // user added one and left it blank
    ],
  });
  assert.equal(out.start, "09:00", "the blank window is discarded, so this is still simple");
  assert.deepEqual(out.windows, []);
}

// ---- round trip -------------------------------------------------------------
{
  for (const original of [
    { enabled: true, start: "09:00", end: "17:00", days: [0, 1], windows: [], timeZone: null, dateFrom: null, dateTo: null },
    {
      enabled: true, start: null, end: null, days: [],
      windows: [{ start: "07:00", end: "09:00", days: [1] }, { start: "17:00", end: "19:00", days: [1] }],
      timeZone: "UTC", dateFrom: "2026-01-01", dateTo: "2026-12-31",
    },
  ]) {
    assert.deepEqual(fromDraft(toDraft(original)), original, "a round trip is lossless");
  }
}

// ---- describe ---------------------------------------------------------------
{
  assert.equal(describe(null), null);
  assert.equal(
    describe({ enabled: true, start: "09:00", end: "17:00", days: [0, 1, 2, 3, 4] }),
    "Mon Tue Wed Thu Fri 09:00–17:00",
  );
  assert.equal(
    describe({ enabled: true, start: "21:00", end: "06:00", days: [] }),
    "every day 21:00–06:00",
    "a window that wraps past midnight still reads sensibly",
  );
  assert.ok(describe({ enabled: false, start: "09:00", end: "17:00", days: [] }).startsWith("(off)"),
    "a disabled schedule says so");
}

console.log("schedule model: ok");
