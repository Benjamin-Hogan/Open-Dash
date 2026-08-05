// Heads-up — pinned status strip (clock, weather, calendar, print).
import { define } from "./registry.js";
import { el, fetchData, effectiveSettings } from "./dom.js";

define("heads-up", {
  meta: {
    label: "Heads-up strip",
    description: "Always-visible glance row (pin to all pages)",
    category: "data",
  },
  schema: {
    fields: [
      { key: "position", label: "Position", type: "select", options: ["bottom", "top"], default: "bottom" },
      { key: "showClock", label: "Show clock", type: "boolean", default: true },
      { key: "showWeather", label: "Show weather", type: "boolean", default: true },
      { key: "showCalendar", label: "Show next calendar event", type: "boolean", default: true },
      { key: "showPrint", label: "Show print status", type: "boolean", default: false },
      { key: "icalUrl", label: "Calendar URL (.ics)", type: "text", placeholder: "https://…/calendar.ics" },
      { key: "octoprintUrl", label: "OctoPrint URL (blank = first printer widget)", type: "text" },
      { key: "units", label: "Weather units", type: "select", options: ["imperial", "metric"], default: "imperial" },
      { key: "refreshSeconds", label: "Data refresh seconds", type: "number", default: 60 },
    ],
  },
  async mount(root, widget) {
    const s = effectiveSettings(widget);
    const strip = el("div", { class: `heads-up heads-up-${s.position || "bottom"}` });
    root.appendChild(strip);
    const handle = { strip, widget, clockTimer: null };
    handle.clockTimer = setInterval(() => updateClock(handle), 1000);
    updateClock(handle);
    await this.refresh(handle, widget);
    return handle;
  },
  async refresh(handle, widget) {
    const w = widget || handle.widget;
    const s = effectiveSettings(w);
    const items = [];
    if (s.showClock !== false) {
      items.push(el("span", { class: "hu-item hu-clock", "data-hu": "clock" }, "—"));
    }
    try {
      const params = clean({
        showWeather: s.showWeather !== false,
        showCalendar: s.showCalendar !== false,
        showPrint: s.showPrint === true,
        icalUrl: s.icalUrl,
        octoprintUrl: s.octoprintUrl,
        units: s.units,
      });
      const d = await fetchData("heads-up", params);
      if (s.showWeather !== false && d.weather?.current) {
        const cur = d.weather.current;
        const deg = d.weather.units === "metric" ? "°C" : "°F";
        items.push(el("span", { class: "hu-item hu-weather" }, [
          el("span", { class: "hu-val" }, `${Math.round(cur.temp)}${deg}`),
          el("span", { class: "hu-sub" }, cur.summary || ""),
        ]));
      }
      if (s.showCalendar !== false && d.calendar) {
        const mins = minutesUntil(d.calendar.start);
        const label = mins != null && mins <= 120
          ? (mins <= 0 ? "Now" : `In ${mins}m`)
          : formatEventTime(d.calendar.start);
        items.push(el("span", { class: "hu-item hu-cal" }, [
          el("span", { class: "hu-val" }, label),
          el("span", { class: "hu-sub" }, d.calendar.title || "Event"),
        ]));
      }
      if (s.showPrint === true && d.print?.configured) {
        const pct = d.print.completion != null ? `${Math.round(d.print.completion)}%` : (d.print.state || "—");
        items.push(el("span", { class: "hu-item hu-print" }, [
          el("span", { class: "hu-val" }, pct),
          el("span", { class: "hu-sub" }, d.print.printing ? "Printing" : (d.print.state || "Printer")),
        ]));
      }
    } catch {
      /* keep partial strip */
    }
    handle.strip.replaceChildren(...items);
    updateClock(handle);
  },
  suspend(handle) {
    clearInterval(handle.clockTimer);
    handle.clockTimer = null;
  },
  resume(handle, widget) {
    if (!handle.clockTimer) {
      handle.clockTimer = setInterval(() => updateClock(handle), 1000);
    }
    return this.refresh(handle, widget || handle.widget);
  },
  destroy(handle) {
    clearInterval(handle.clockTimer);
  },
});

function updateClock(handle) {
  const node = handle.strip?.querySelector("[data-hu=clock]");
  if (!node) return;
  const now = new Date();
  node.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function minutesUntil(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 60000);
}

function formatEventTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Soon";
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && v !== "") out[k] = v;
  }
  return out;
}
