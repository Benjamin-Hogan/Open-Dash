// Logic behind the ten newer widgets: the shared formatter, reminder dates,
// what Up next and Week ahead show, the UV window, the tide curve, the launch
// countdown, quake place names, the service headline and wind words.
import assert from "node:assert/strict";

const fmt = await import("../web/js/widgets/fmt.js");
const { nextDue, arrange } = await import("../web/js/widgets/reminders.js");
const { plan } = await import("../web/js/widgets/up-next.js");
const { layout } = await import("../web/js/widgets/week-ahead.js");
const uv = await import("../web/js/widgets/uv-index.js");
const { tideAt } = await import("../web/js/widgets/tides.js");
const { tMinus } = await import("../web/js/widgets/launches.js");
const { placeName } = await import("../web/js/widgets/earthquakes.js");
const { headline } = await import("../web/js/widgets/service-status.js");
const { cardinal, beaufort } = await import("../web/js/widgets/wind.js");
const { yearsAgo } = await import("../web/js/widgets/on-this-day.js");

const NOW = new Date(2026, 9, 2, 15, 50); // Friday 2 Oct 2026, 3:50 PM
const at = (days, h = 0, m = 0) => new Date(2026, 9, 2 + days, h, m);
const NB = " ";

// ---- formatter -------------------------------------------------------------------------
assert.equal(fmt.span(65 * 60000), `1${NB}h 5${NB}min`);
assert.equal(fmt.span(25 * 60000 + 59000), `25${NB}min`);
assert.equal(fmt.span(2 * 3600000), `2${NB}h`);
assert.equal(fmt.span(3 * 86400000), `3${NB}days`);
assert.equal(fmt.day(at(0), NOW), "Today");
assert.equal(fmt.day(at(1), NOW), "Tomorrow");
assert.equal(fmt.day(at(-1), NOW), "Yesterday");
assert.match(fmt.day(at(2), NOW), /^Sun/);
assert.match(fmt.day(at(12), NOW), /14/);
assert.equal(fmt.nb("drop-off"), "drop‑off");
assert.equal(fmt.minus("-0.2"), "−0.2");
assert.equal(fmt.parseWhen("2026-10-02T15:30:00").getHours(), 15);
assert.equal(fmt.parseWhen("2026-10-02").getDate(), 2);
assert.equal(fmt.parseWhen("2026-10-02T15:30:00Z").getTime(), Date.UTC(2026, 9, 2, 15, 30));
assert.doesNotMatch(fmt.time(at(0, 13)), /:00/);
assert.match(fmt.time(at(0, 16, 55)), /55/);
assert.doesNotMatch(fmt.time(at(0, 8)), / /, "time keeps a no-break space");

// ---- reminders -------------------------------------------------------------------------
const ymd = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].join("-");
assert.equal(ymd(nextDue({ repeat: "weekly", weekday: "4" }, NOW)), "2026-10-2", "Friday is today");
assert.equal(ymd(nextDue({ repeat: "weekly", weekday: "6" }, NOW)), "2026-10-4");
assert.equal(ymd(nextDue({ repeat: "weekly", weekday: "0" }, NOW)), "2026-10-5");
assert.equal(ymd(nextDue({ repeat: "weeks", every: 2, date: "2026-09-25" }, NOW)), "2026-10-9");
assert.equal(ymd(nextDue({ repeat: "weeks", every: 2, date: "2026-09-18" }, NOW)), "2026-10-2");
assert.equal(ymd(nextDue({ repeat: "weeks", every: 2, date: "2026-11-01" }, NOW)), "2026-11-1", "a start in the future is the first time");
assert.equal(ymd(nextDue({ repeat: "monthly", dayOfMonth: 1 }, NOW)), "2026-11-1");
assert.equal(ymd(nextDue({ repeat: "monthly", dayOfMonth: 31 }, new Date(2027, 1, 3))), "2027-2-28", "31st means the last day");
assert.equal(ymd(nextDue({ repeat: "yearly", date: "2020-02-29" }, NOW)), "2027-2-28");
assert.equal(nextDue({ repeat: "once", date: "2026-10-01" }, NOW), null);
{
  const r = arrange([
    { label: "Trash", repeat: "weekly", weekday: "4", evening: true },
    { label: "Recycling", repeat: "weekly", weekday: "4", evening: true },
    { label: "Plants", repeat: "weekly", weekday: "6" },
    { label: "" , repeat: "weekly", weekday: "4" },
  ], NOW);
  assert.equal(r.hero.word, "Tonight");
  assert.deepEqual(r.hero.items.map((x) => x.r.label), ["Recycling", "Trash"]);
  assert.deepEqual(r.rest.map((x) => x.r.label), ["Plants"]);
  const day = arrange([{ label: "Pills", repeat: "weekly", weekday: "4" }, { label: "Bins", repeat: "weekly", weekday: "4", evening: true }], NOW);
  assert.equal(day.hero.word, "Today", "daytime first");
  assert.equal(arrange([{ label: "Plants", repeat: "weekly", weekday: "6" }], NOW).hero, null);
}

// ---- up next -----------------------------------------------------------------------------
const cal = { name: "Sam", colour: "blue", holidays: false };
const ev = (title, s, e, extra = {}) => ({ title, start: s, end: e, allDay: false, where: "", cal, ...extra });
{
  const events = [
    ev("Piano", at(0, 15, 30), at(0, 16, 15)),
    ev("Soccer", at(0, 16, 55), at(0, 18)),
    ev("Dinner", at(0, 18, 30), at(0, 20)),
    ev("Market", at(1, 8), at(1, 10)),
    { ...ev("Holiday", at(0), at(1)), allDay: true },
  ];
  const p = plan(events, NOW);
  assert.equal(p.now.title, "Piano");
  assert.equal(p.next.title, "Soccer");
  assert.ok(p.nextIsToday);
  assert.deepEqual(p.later.map((e) => e.title), ["Dinner"]);
  assert.equal(p.freeAt.getHours(), 20);
  const evening = plan(events, at(0, 21));
  assert.equal(evening.now, null);
  assert.equal(evening.next.title, "Market");
  assert.equal(evening.nextIsToday, false);
}

// ---- week ahead -------------------------------------------------------------------------
{
  const hol = { name: "", colour: "amber", holidays: true };
  const fam = (c) => ({ name: "", colour: c, holidays: false });
  const allDay = (title, d0, d1, c) => ({ title, start: at(d0), end: at(d1 + 1), allDay: true, where: "", cal: c });
  const L = layout([
    allDay("Grandparents", 2, 3, fam("purple")),
    allDay("Holiday", 3, 3, hol),
    allDay("No school", 3, 3, fam("green")),
    allDay("Last week's trip", -5, -2, fam("blue")),
    ev("Swim", at(3, 15, 30), at(3, 16, 30)),
    ev("Too late", at(7, 9), at(7, 10)),
  ], NOW);
  assert.equal(L.days.length, 7);
  assert.deepEqual(L.days[3].timed.map((e) => e.title), ["Swim"]);
  assert.equal(L.days.flatMap((d) => d.timed).length, 1, "day 8 is outside the week");
  const laneTitles = L.lanes.map((l) => l.map((a) => a.ev.title));
  assert.deepEqual(laneTitles, [["Grandparents"], ["No school"]], "holidays give way first");
  assert.equal(L.extra[3], 1);
  assert.equal(L.extraHolidayOnly[3], true);
  assert.equal(L.lanes[0][0].from, 2);
  assert.equal(L.lanes[0][0].to, 3, "all-day end is exclusive");
}

// ---- UV ----------------------------------------------------------------------------------
{
  const vals = [0, 0, 0, 0, 0, 0, 0, .3, 1.1, 2.4, 4.0, 5.7, 7.2, 8.1, 7.8, 7.0, 6.1, 3.4, 1.4, .2, 0, 0, 0, 0];
  const pad = (n) => String(n).padStart(2, "0");
  const hours = [...vals.map((v, h) => ({ time: `2026-10-02T${pad(h)}:00`, uv: v })), ...vals.map((v, h) => ({ time: `2026-10-03T${pad(h)}:00`, uv: v * 1.1 }))];
  const data = { today: "2026-10-02", hours, days: [{ date: "2026-10-02" }, { date: "2026-10-03" }] };
  const s = uv.summarize(data, NOW);
  assert.equal(Math.round(s.value), 6);
  assert.equal(s.band[1], "High");
  assert.match(s.message, /^Sunscreen until 5:15/);
  const morning = uv.summarize(data, at(0, 7));
  assert.match(morning.message, /^Sunscreen 9:30.*5:15/); // crosses 3 at 9:22, to the quarter hour
  const night = uv.summarize(data, at(0, 21));
  assert.equal(night.day, "tomorrow");
  assert.equal(night.tomorrow.peak, 9);
  assert.equal(night.tomorrow.band[1], "Very high");
  assert.equal(uv.band(11)[1], "Extreme");
  assert.equal(uv.band(2.4)[1], "Low");
}

// ---- tides, launches, quakes, services, wind, on this day ---------------------------------
{
  const evs = [{ t: 0, height: 0 }, { t: 100, height: 4 }];
  assert.equal(tideAt(evs, 0), 0);
  assert.ok(Math.abs(tideAt(evs, 50) - 2) < 1e-9);
  assert.equal(tideAt(evs, 100), 4);
  assert.equal(tideAt(evs, 101), null);
}
const H = 3600000;
assert.deepEqual(tMinus(26 * H + 30 * 60000), [[1, "day"], [2, "h"]]);
assert.deepEqual(tMinus(5 * 86400000), [[5, "days"]]);
assert.deepEqual(tMinus(5 * H + 12 * 60000), [[5, "h"], [12, "min"]]);
assert.deepEqual(tMinus(38 * 60000), [[38, "min"]]);
assert.equal(placeName("12 km SW of Ridgecrest, CA"), "Ridgecrest, CA");
assert.equal(placeName("8 km N of Black Canyon City, Arizona"), "Black Canyon City, AZ");
assert.equal(placeName("Gulf of California"), "Gulf of California");
{
  const T = Date.now();
  const up = (name) => ({ name, state: "up", ms: 5, since: T });
  assert.equal(headline([up("A"), up("B")], T).title, "All 2 up");
  const h = headline([{ name: "NAS", state: "down", since: T - 12 * 60000 }, up("B")], T);
  assert.equal(h.title, "NAS is down");
  assert.match(h.sub, /^For 12.min · 1 other up$/);
  assert.equal(headline([{ name: "A", state: "down", since: T }, { name: "B", state: "down", since: T }], T).title, "2 services down");
  assert.match(headline([up("A"), { name: "P", state: "slow", ms: 1200, since: T }], T).sub, /P is slow/);
}
assert.equal(cardinal(225), "SW");
assert.equal(cardinal(359), "N");
assert.equal(cardinal(-45), "NW");
assert.equal(beaufort(14), "Breezy");
assert.equal(beaufort(0), "Calm");
assert.equal(yearsAgo(1958, NOW), "68 years ago");
assert.equal(yearsAgo(2025, NOW), "1 year ago");

console.log("widgets (more): ok");
