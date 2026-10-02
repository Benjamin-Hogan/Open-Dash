// Logic behind the widget refresh: the 24-hour summary sentence, the monotone
// chart curve, countdown dates, world-clock offsets and the weather day labels.
import assert from "node:assert/strict";

// The widget modules only touch the DOM inside mount/render, so importing them
// in Node is safe; they self-register into the shared registry.
const { summarize, monotonePath } = await import("../web/js/widgets/next-24h.js");
const { upcoming } = await import("../web/js/widgets/countdown.js");
const { offsetText } = await import("../web/js/widgets/world-clocks.js");
const { dow, hourLabel, RAIN_MIN } = await import("../web/js/widgets/weather.js");
const { band } = await import("../web/js/widgets/air-quality.js");
const { ago } = await import("../web/js/widgets/dom.js");

// ---- next 24 hours summary -----------------------------------------------------
const hoursFrom = (startHour, rains, temps) => rains.map((r, i) => {
  const h = (startHour + i) % 24;
  const day = startHour + i >= 24 ? "02" : "01";
  return { time: `2026-10-${day}T${String(h).padStart(2, "0")}:00`, rain: r, temp: temps?.[i] ?? 80, code: r >= 20 ? 80 : 0 };
});
{
  const dry = summarize(hoursFrom(18, Array(25).fill(0)), "2026-10-01");
  assert.equal(dry.headline, "Dry for the next 24 hours");
  assert.match(dry.detail, /^Low 80°, high 80°\.$/);
}
{
  // Showers 1–4 PM tomorrow peaking at 40%.
  const rains = Array(25).fill(0);
  rains[19] = 20; rains[20] = 30; rains[21] = 40; rains[22] = 25;
  const s = summarize(hoursFrom(18, rains), "2026-10-01");
  assert.match(s.headline, /^Showers possible 1\s?–\s?4\s?PM tomorrow$/, s.headline);
  assert.match(s.detail, /^Up to 40% chance\. Dry tonight\./);
}
{
  const rains = Array(25).fill(0); rains[3] = 70;
  const s = summarize(hoursFrom(18, rains), "2026-10-01");
  assert.match(s.headline, /^Rain likely around 9\s?PM tonight$/, s.headline);
}
{
  const s = summarize(hoursFrom(18, Array(25).fill(80)), "2026-10-01");
  assert.match(s.headline, /^Rain likely now/);
}

// ---- monotone curve: passes through every point and never overshoots ----------
{
  const pts = [[0, 50], [10, 50], [20, 10], [30, 10], [40, 60]];
  const d = monotonePath(pts);
  assert.match(d, /^M0\.0 50\.0 C/);
  // Every control point's y stays within the range of its segment's ends.
  const nums = d.replace(/[MC]/g, " ").trim().split(/\s+/).map(Number);
  const ys = [];
  for (let i = 1; i < nums.length; i += 2) ys.push(nums[i]);
  // ys: start, then (c1, c2, end) per segment
  for (let seg = 0; seg < pts.length - 1; seg++) {
    const [c1, c2] = [ys[1 + seg * 3], ys[2 + seg * 3]];
    const lo = Math.min(pts[seg][1], pts[seg + 1][1]), hi = Math.max(pts[seg][1], pts[seg + 1][1]);
    for (const c of [c1, c2]) assert.ok(c >= lo - 1e-6 && c <= hi + 1e-6, `segment ${seg} control ${c} outside ${lo}..${hi}`);
  }
}

// ---- countdown --------------------------------------------------------------------
{
  const now = new Date(2026, 9, 1, 18, 0); // Oct 1 2026, 6 PM local
  const list = upcoming([
    { label: "Trip", date: "2026-10-13" },
    { label: "Past", date: "2026-09-01" },
    { label: "Birthday", date: "1960-11-04", yearly: true },
    { label: "New Year", date: "2000-01-01", yearly: true },
    { label: "Today thing", date: "2026-10-01" },
    { label: "", date: "2026-12-01" },          // no label: skipped
    { label: "No date", date: "" },             // no date: skipped
  ], now);
  assert.deepEqual(list.map((e) => [e.label, e.days]), [
    ["Today thing", 0], ["Trip", 12], ["Birthday", 34], ["New Year", 92],
  ]);
}

// ---- world clocks ------------------------------------------------------------------
{
  // Run with the display in Phoenix (UTC-7, no DST) regardless of the machine.
  const at = new Date("2026-10-02T00:58:00Z"); // 5:58 PM in Phoenix
  process.env.TZ = "America/Phoenix";
  assert.equal(offsetText(at, "America/New_York"), "3 h ahead");
  assert.equal(offsetText(at, "Europe/London"), "8 h ahead, tomorrow");
  assert.equal(offsetText(at, "America/Phoenix"), "Same time");
  assert.equal(offsetText(at, "Asia/Kolkata"), "12 h 30 min ahead, tomorrow");
  assert.equal(offsetText(at, "Pacific/Honolulu"), "3 h behind");
}

// ---- weather labels -----------------------------------------------------------------
{
  // The bug: "2026-10-01" parsed as UTC midnight read as Sep 30 west of Greenwich.
  process.env.TZ = "America/Phoenix";
  const thursday = new Date(2026, 9, 1).toLocaleDateString(undefined, { weekday: "short" });
  assert.equal(dow("2026-10-01"), thursday);
  assert.match(hourLabel("2026-10-01T21:00"), /9\s?PM/);
  assert.equal(RAIN_MIN, 10);
}

// ---- air quality bands and "ago" ------------------------------------------------------
assert.equal(band(66)[1], "moderate");
assert.equal(band(50)[1], "good");
assert.equal(band(301)[1], "hazardous");
assert.equal(band(null), null);
assert.equal(ago(Date.now() - 30_000), "just now");
assert.equal(ago(Date.now() - 2 * 3600_000), "2 h ago");

console.log("widgets ok");
