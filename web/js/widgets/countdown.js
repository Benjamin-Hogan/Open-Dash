// Countdown — days until the things you're looking forward to. The nearest is
// the headline; the next few are listed. Past one-off events drop off on their
// own; yearly ones (birthdays, holidays) roll over to next year. On the day,
// the event's name becomes the headline.
import { define } from "./registry.js";
import { el, stateView } from "./dom.js";

define("countdown", {
  meta: {
    label: "Countdown",
    description: "Days until upcoming events, birthdays and holidays",
    category: "basic",
  },
  schema: {
    fields: [
      {
        key: "events", label: "Events", type: "list", itemLabel: "Event", addLabel: "+ Add an event",
        emptyText: "Nothing to count down to yet.",
        default: [],
        newItem: { label: "", date: "", yearly: false },
        itemTitle: (e, i) => e.label || `Event ${i + 1}`,
        itemFields: [
          { key: "label", label: "What", type: "text", required: true, placeholder: "Grand Canyon trip" },
          { key: "date", label: "Date", type: "date", required: true },
          { key: "yearly", label: "Every year", type: "boolean", help: "For birthdays and holidays." },
        ],
      },
      { key: "listCount", label: "How many to list under the next one", type: "number", default: 3, min: 0, max: 6 },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "countdown" });
    root.appendChild(body);
    const handle = { body, widget };
    render(handle);
    // Days only change at midnight; a few minutes' lag is fine.
    handle.timer = setInterval(() => render(handle), 5 * 60000);
    return handle;
  },
  refresh(handle, widget) { if (widget) handle.widget = widget; render(handle); },
  suspend(handle) { clearInterval(handle.timer); handle.timer = null; },
  resume(handle) { if (!handle.timer) handle.timer = setInterval(() => render(handle), 5 * 60000); render(handle); },
  destroy(handle) { clearInterval(handle.timer); },
});

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Upcoming events, soonest first: [{ label, when: Date, days }]. Exported for tests. */
export function upcoming(events, now = new Date()) {
  const today = dayStart(now);
  const out = [];
  for (const e of events || []) {
    const [y, m, d] = String(e?.date || "").split("-").map(Number);
    if (!e?.label?.trim() || !y || !m || !d) continue;
    let when = new Date(y, m - 1, d);
    if (e.yearly) {
      when = new Date(today.getFullYear(), m - 1, d);
      if (when < today) when = new Date(today.getFullYear() + 1, m - 1, d);
    }
    if (when < today) continue;
    out.push({ label: e.label.trim(), when, days: Math.round((when - today) / 86400000) });
  }
  return out.sort((a, b) => a.when - b.when);
}

function dateText(d, now) {
  const opts = { weekday: "long", month: "long", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

const daysText = (n) => (n === 1 ? "1 day" : `${n} days`);

function render(handle) {
  const s = handle.widget.settings || {};
  const now = new Date();
  const list = upcoming(s.events, now);
  if (!list.length) {
    handle.body.replaceChildren(stateView({
      icon: "calendar", title: "Add something to count down to",
      body: "A trip, a birthday, a holiday: add events in this widget's settings.",
      where: "Admin › Layout › Countdown",
    }));
    return;
  }
  const [next, ...rest] = list;
  const special = next.days === 0 ? "Today" : next.days === 1 ? "Tomorrow" : null;
  const hero = el("div", { class: "cd-hero" }, special
    ? [
      el("div", { class: "cd-when-word" }, special),
      el("div", { class: "cd-what cd-what-big" }, next.label),
      el("div", { class: "cd-date" }, next.days === 0 ? "Have a great time" : dateText(next.when, now)),
    ]
    : [
      el("div", { class: "cd-n" }, [String(next.days), el("small", {}, next.days === 1 ? "day" : "days")]),
      el("div", { class: "cd-what" }, next.label),
      el("div", { class: "cd-date" }, dateText(next.when, now)),
    ]);
  const count = Math.max(0, Math.min(6, Number(s.listCount ?? 3)));
  const items = rest.slice(0, count).map((e) =>
    el("div", { class: "cd-item" }, [el("b", {}, e.label), el("span", {}, e.days === 1 ? "Tomorrow" : daysText(e.days))]));
  handle.body.classList.toggle("is-today", next.days === 0);
  handle.body.classList.toggle("is-soon", next.days === 1);
  // filter(Boolean): replaceChildren(null) would render the text "null".
  handle.body.replaceChildren(...[hero, items.length ? el("div", { class: "cd-list" }, items) : null].filter(Boolean));
}
