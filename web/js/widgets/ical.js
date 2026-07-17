// Calendar agenda from a public iCal (.ics) feed — parsed server-side (provider
// "ical", with recurrence expansion). Shows upcoming events, grouped by day.
import { define } from "./registry.js";
import { el, fetchData, effectiveSettings } from "./dom.js";

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""));
}

define("ical", {
  meta: { label: "Calendar", description: "Agenda from an iCal feed", category: "data" },
  schema: {
    fields: [
      { key: "url", label: "iCal URL (.ics — Google/Outlook 'public address')", type: "text", required: true, placeholder: "https://…/basic.ics" },
      { key: "count", label: "Events to show", type: "number", default: 10 },
      { key: "lookaheadDays", label: "Lookahead days", type: "number", default: 60 },
      { key: "showLocation", label: "Show event location", type: "boolean", default: false },
      { key: "cacheTtlSeconds", label: "Server cache TTL seconds (blank = default)", type: "number" },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "ical" });
    root.appendChild(body);
    const handle = { body, widget };
    await this.refresh(handle);
    return handle;
  },
  async refresh(handle) {
    const s = effectiveSettings(handle.widget);
    if (!s.url) { handle.body.replaceChildren(el("div", { class: "widget-empty" }, "Set an iCal URL")); return; }
    try {
      const d = await fetchData("ical", clean({
        url: s.url,
        count: s.count || 10,
        lookaheadDays: s.lookaheadDays || 60,
        cacheTtl: s.cacheTtlSeconds,
      }));
      const events = d.events || [];
      if (!events.length) { handle.body.replaceChildren(el("div", { class: "widget-empty" }, "No upcoming events")); return; }
      const rows = [];
      let lastDay = "";
      for (const ev of events) {
        const dt = new Date(ev.start);
        const dayKey = dt.toDateString();
        if (dayKey !== lastDay) {
          lastDay = dayKey;
          rows.push(el("div", { class: "ical-day" }, dayLabel(dt)));
        }
        const bits = [
          el("span", { class: "ical-time" }, ev.allDay ? "all day" : dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })),
          el("span", { class: "ical-sum" }, ev.summary || "(no title)"),
        ];
        if (s.showLocation && ev.location) {
          bits.push(el("span", { class: "ical-loc" }, ev.location));
        }
        rows.push(el("div", { class: "ical-ev" }, bits));
      }
      handle.body.replaceChildren(el("div", { class: "ical-list" }, rows));
    } catch {
      handle.body.replaceChildren(el("div", { class: "widget-error" }, "calendar unavailable"));
    }
  },
});

function dayLabel(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = new Date(d); t.setHours(0, 0, 0, 0);
  const diff = Math.round((t - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
