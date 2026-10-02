// Up next — the calendar's one question: what's happening now, and what's
// next? The countdown to the next event is the hero; the rest of today is
// listed with times, ending in "Free for the rest of the day". With nothing
// left today it names the next thing coming.
import { define } from "./registry.js";
import { el, loadInto, stateView } from "./dom.js";
import { time, day, span, nb, daysBetween } from "./fmt.js";
import { calendarsField, usable, loadEvents } from "./calendars.js";

define("up-next", {
  meta: {
    label: "Up next",
    description: "What's on now and what's next, from one or more calendars",
    category: "data",
    showTitle: false,
    defaultRefreshSeconds: 900,
  },
  schema: { fields: [calendarsField] },
  async mount(root, widget) {
    const body = el("div", { class: "upnext" });
    root.appendChild(body);
    const handle = { body, widget, events: null };
    await this.refresh(handle, widget);
    // Countdowns move every minute; the feed refreshes on its own interval.
    handle.timer = setInterval(() => { if (handle.events) render(handle); }, 30000);
    return handle;
  },
  async refresh(handle, widget) {
    if (widget) handle.widget = widget;
    if (!usable(handle.widget.settings).length) {
      handle.events = null;
      handle.body.replaceChildren(stateView({
        icon: "calendar", title: "Up next: add a calendar",
        body: "Paste a calendar's iCal link in this widget's settings.", where: "Admin › Layout › Up next",
      }));
      return;
    }
    await loadInto(handle, {
      load: () => loadEvents(handle.widget.settings, 8),
      render: (events) => { handle.events = events; render(handle); },
      error: { title: "Can't load the calendar" },
    });
  },
  suspend(handle) { clearInterval(handle.timer); handle.timer = null; },
  resume(handle) {
    if (!handle.timer) handle.timer = setInterval(() => { if (handle.events) render(handle); }, 30000);
    if (handle.events) render(handle);
  },
  destroy(handle) { clearInterval(handle.timer); },
});

/**
 * What the card shows. Exported for tests.
 * @returns {{ now?, next?, later: [], freeAt?: Date, nextIsToday: boolean }}
 */
export function plan(events, now = new Date()) {
  const timed = events.filter((e) => !e.allDay);
  const current = timed.filter((e) => e.start <= now && e.end > now).sort((a, b) => a.end - b.end)[0] || null;
  const next = timed.find((e) => e.start > now) || null;
  const nextIsToday = !!next && daysBetween(next.start, now) === 0;
  const today = timed.filter((e) => daysBetween(e.start, now) === 0);
  const later = nextIsToday ? today.filter((e) => e.start > next.start) : [];
  const lastEnd = today.reduce((m, e) => (e.end > m ? e.end : m), current?.end || null);
  const freeAt = lastEnd && daysBetween(lastEnd, now) === 0 && (nextIsToday || current) ? lastEnd : null;
  return { now: current, next, later, freeAt, nextIsToday };
}

const colour = (e) => ({ "--cal": `var(--tag-${e.cal.colour})` });

function render(handle) {
  const now = new Date();
  const p = plan(handle.events, now);
  const parts = [];
  if (p.now) {
    const pct = Math.round(((now - p.now.start) / (p.now.end - p.now.start)) * 100);
    parts.push(el("div", { class: "un-now", style: colour(p.now) }, [
      el("span", { class: "un-bar" }),
      el("div", { class: "eyebrow" }, p.now.cal.name ? `Now · ${p.now.cal.name}` : "Now"),
      el("div", { class: "un-what" }, nb(p.now.title)),
      el("div", { class: "un-when" }, `Ends in ${span(p.now.end - now)} · ${time(p.now.end)}`),
      el("div", { class: "un-prog", role: "img", "aria-label": `${pct}% done` }, el("i", { style: { width: `${pct}%` } })),
    ]));
  }
  if (p.next && p.nextIsToday) {
    parts.push(el("div", { class: "un-next", style: colour(p.next) }, [
      el("div", { class: "eyebrow" }, p.next.cal.name ? `Next · ${p.next.cal.name}` : "Next"),
      el("div", { class: "un-in" }, span(p.next.start - now)),
      el("div", { class: "un-title" }, [el("span", { class: "cal-dot" }), el("span", {}, nb(p.next.title))]),
      // The place's detail after its first comma is the first thing a small card drops.
      el("div", { class: "un-sub" }, [el("b", {}, time(p.next.start)), ...(p.next.where ? [
        ` · ${p.next.where.split(",")[0]}`,
        p.next.where.includes(",") ? el("span", { class: "un-where-more" }, p.next.where.slice(p.next.where.indexOf(","))) : null,
      ] : [])]),
    ]));
    const rows = p.later.map((e) => el("div", { class: "un-row" }, [
      el("span", { class: "un-t" }, time(e.start)),
      el("span", { class: "un-n", style: colour(e) }, [el("span", { class: "cal-dot" }), nb(e.title)]),
    ]));
    if (p.freeAt) rows.push(el("div", { class: "un-row free" }, [el("span", { class: "un-t" }, time(p.freeAt)), el("span", { class: "un-n" }, [el("span", { class: "cal-dot", style: { visibility: "hidden" } }), "Free for the rest of the day"])]));
    if (rows.length) parts.push(el("div", { class: "un-later" }, rows));
  } else {
    // Nothing more today: name what's next, whenever it is.
    const n = p.next;
    parts.push(el("div", { class: "un-free" }, [
      el("div", { class: "eyebrow" }, "Rest of today"),
      el("div", { class: "un-big" }, p.now ? "Nothing after this" : "Nothing else on the calendar"),
      n ? el("div", { class: "un-sub2" }, daysBetween(n.start, now) === 1
        ? ["Tomorrow starts with ", el("b", {}, nb(n.title)), ` at ${time(n.start)}.`]
        : ["Next: ", el("b", {}, nb(n.title)), `, ${day(n.start, now)} at ${time(n.start)}.`]) : null,
    ]));
  }
  handle.body.classList.toggle("has-now", !!p.now);
  handle.body.classList.toggle("is-free", !(p.next && p.nextIsToday));
  // A long name wraps to two lines in a small card and the place is dropped
  // first (truncation order: the secondary field goes before the primary).
  handle.body.classList.toggle("long", !!p.next && p.next.title.length > 24);
  handle.body.replaceChildren(...parts);
}
