// Week ahead — seven days as columns, today first. Each day carries its
// weather (rain chance replaces the low when it's 30% or more), its all-day
// events as one-line chips that span their days, then its timed events in
// their calendar's colour. When space runs out, holidays give way first and
// timed events that don't fit whole become "+N more".
import { define } from "./registry.js";
import { el, fetchData, loadInto, stateView, fmtNum } from "./dom.js";
import { time, nb, daysBetween } from "./fmt.js";
import { calendarsField, usable, loadEvents } from "./calendars.js";
import { wxIcon } from "./weather.js";

const WET = 30;
const LANES = 2;

define("week-ahead", {
  meta: {
    label: "Week ahead",
    description: "Seven days of calendar events, with each day's weather",
    category: "data",
    showTitle: false,
    defaultRefreshSeconds: 1800,
  },
  schema: {
    fields: [
      calendarsField,
      { key: "showWeather", label: "Show each day's weather", type: "boolean", default: true },
      { key: "units", label: "Units", type: "select", default: "imperial", options: [
        { value: "imperial", label: "Fahrenheit" }, { value: "metric", label: "Celsius" },
      ] },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "week" });
    root.appendChild(body);
    const handle = { body, widget, data: null };
    handle.ro = new ResizeObserver(() => { if (handle.data) render(handle); });
    handle.ro.observe(body);
    await this.refresh(handle, widget);
    return handle;
  },
  async refresh(handle, widget) {
    if (widget) handle.widget = widget;
    const s = handle.widget.settings || {};
    if (!usable(s).length && s.showWeather === false) {
      handle.data = null;
      handle.body.replaceChildren(stateView({
        icon: "calendar", title: "Week ahead: add a calendar",
        body: "Paste a calendar's iCal link in this widget's settings.", where: "Admin › Layout › Week ahead",
      }));
      return;
    }
    await loadInto(handle, {
      load: async () => {
        const [events, wx] = await Promise.all([
          usable(s).length ? loadEvents(s, 8) : [],
          s.showWeather === false ? null : fetchData("weather", { units: s.units || "imperial" }).catch(() => null),
        ]);
        return { events, wx };
      },
      render: (d) => { handle.data = d; render(handle); },
      error: { title: "Can't load the calendar" },
    });
  },
  destroy(handle) { handle.ro?.disconnect(); },
});

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Lay the week out. Exported for tests.
 * @returns {{ days: [{date, timed: []}], lanes: [[{ev, from, to}]], extra: number[] }}
 */
export function layout(events, now = new Date()) {
  const days = Array.from({ length: 7 }, (_, i) => ({ date: new Date(now.getFullYear(), now.getMonth(), now.getDate() + i), timed: [] }));
  const allDay = [];
  for (const e of events) {
    if (e.allDay) {
      // iCal's all-day end is exclusive: an event on the 3rd ends on the 4th.
      const from = Math.max(0, daysBetween(e.start, now));
      const to = Math.min(6, daysBetween(new Date(e.end.getTime() - 1), now));
      if (to >= 0 && from <= 6 && to >= from) allDay.push({ ev: e, from, to });
    } else {
      const i = daysBetween(e.start, now);
      // An event already running when the day began is shown on its first day only.
      if (i >= 0 && i < 7) days[i].timed.push(e);
    }
  }
  // Family events before holidays; longer spans first so they keep a lane.
  allDay.sort((a, b) => (a.ev.cal.holidays ? 1 : 0) - (b.ev.cal.holidays ? 1 : 0) || (b.to - b.from) - (a.to - a.from) || a.from - b.from);
  const lanes = Array.from({ length: LANES }, () => []);
  const extra = Array(7).fill(0), extraHolidayOnly = Array(7).fill(true);
  for (const a of allDay) {
    const lane = lanes.find((l) => l.every((o) => o.to < a.from || o.from > a.to));
    if (lane) lane.push(a);
    else for (let d = a.from; d <= a.to; d++) { extra[d]++; if (!a.ev.cal.holidays) extraHolidayOnly[d] = false; }
  }
  return { days, lanes, extra, extraHolidayOnly };
}

function render(handle) {
  const now = new Date();
  const { events, wx } = handle.data;
  const { days, lanes, extra, extraHolidayOnly } = layout(events, now);
  const forecast = new Map((wx?.forecast || []).map((f) => [f.date, f]));
  const cols = [], cells = [];
  days.forEach((d, i) => {
    const weekend = d.date.getDay() === 0 || d.date.getDay() === 6;
    cols.push(el("div", { class: "wk-col" + (weekend ? " weekend" : ""), style: { gridColumn: i + 1 } }));
    cells.push(el("div", { class: "wk-h" + (i === 0 ? " today" : ""), style: { gridColumn: i + 1 } }, [
      el("span", { class: "dw" }, i === 0 ? "Today" : d.date.toLocaleDateString(undefined, { weekday: "short" })),
      el("span", { class: "dn" }, String(d.date.getDate())),
    ]));
    if (wx) {
      const f = forecast.get(isoDate(d.date));
      cells.push(el("div", { class: "wk-wx", style: { gridColumn: i + 1 } }, f ? [
        wxIcon(f.code, true, "wk-wx-icon"),
        el("b", {}, `${fmtNum(f.max)}°`),
        f.rain >= WET ? el("span", { class: "wet" }, `${f.rain}% rain`) : el("span", {}, `${fmtNum(f.min)}°`),
      ] : [el("span", {}, "")]));
    }
    // This column's all-day chips: a chip lives in its first visible day and
    // is drawn as wide as its days; later days keep an empty slot of its height.
    const used = lanes.map((l) => l.find((a) => a.from <= i && a.to >= i));
    const last = used.map(Boolean).lastIndexOf(true);
    const chips = used.slice(0, last + 1).map((a) => {
      if (!a || a.from !== i) return el("div", { class: "wk-slot" });
      const n = a.to - a.from + 1;
      return el("div", {
        class: "wk-chip" + (a.ev.cal.holidays ? " holiday" : ""),
        style: { "--cal": `var(--tag-${a.ev.cal.colour})`, width: `calc(${n * 100}% + ${n - 1}px - 10px)` },
        title: a.ev.title,
      }, nb(a.ev.title));
    });
    if (extra[i]) chips.push(el("div", { class: "wk-chip more" }, extraHolidayOnly[i] ? `+${extra[i]} holiday` : `+${extra[i]} all-day`));
    const timed = d.timed.map((e) => el("div", { class: "wk-ev", style: { "--cal": `var(--tag-${e.cal.colour})` } }, [
      el("div", { class: "t" }, time(e.start)),
      el("div", { class: "n" }, nb(e.title)),
    ]));
    const empty = !timed.length && !chips.length ? el("div", { class: "wk-none" }, "Nothing planned") : null;
    cells.push(el("div", { class: "wk-evs", style: { gridColumn: i + 1, gridRow: wx ? 3 : 2 } },
      [chips.length ? el("div", { class: "wk-allday" }, chips) : null, ...timed, empty].filter(Boolean)));
  });
  handle.body.classList.toggle("no-wx", !wx);
  handle.body.replaceChildren(el("div", { class: "wk" }, [...cols, ...cells]));
  fit(handle);
}

/** Drop timed events that don't fit whole; count them in "+N more". */
function fit(handle) {
  const bottom = handle.body.getBoundingClientRect().bottom;
  for (const col of handle.body.querySelectorAll(".wk-evs")) {
    let hidden = 0, more = null;
    const over = () => (col.lastElementChild?.getBoundingClientRect().bottom ?? 0) > bottom + 0.5;
    while (over() && col.querySelector(".wk-ev")) {
      [...col.querySelectorAll(".wk-ev")].pop().remove();
      hidden++;
      if (!more) { more = el("div", { class: "wk-more" }); col.appendChild(more); }
      more.textContent = `+${hidden} more`;
    }
  }
}
