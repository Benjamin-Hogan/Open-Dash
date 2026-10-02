// World clocks — up to five places: the time there, whether it's day or night
// (from the sun's real position, not a fixed 6-to-6 window), and how far ahead
// or behind it is, including "tomorrow". No network.
import { define } from "./registry.js";
import { el, stateView } from "./dom.js";
import { isDaylight } from "./astro.js";

// Time zones offered in the admin, with a representative city's coordinates
// for day/night. A zone not in this list still works; it just falls back to
// 6 AM–6 PM for day/night.
export const ZONES = [
  ["Pacific/Honolulu", "Honolulu", 21.31, -157.86],
  ["America/Anchorage", "Anchorage", 61.22, -149.9],
  ["America/Los_Angeles", "Los Angeles", 34.05, -118.24],
  ["America/Vancouver", "Vancouver", 49.28, -123.12],
  ["America/Phoenix", "Phoenix", 33.45, -112.07],
  ["America/Denver", "Denver", 39.74, -104.99],
  ["America/Chicago", "Chicago", 41.88, -87.63],
  ["America/Mexico_City", "Mexico City", 19.43, -99.13],
  ["America/New_York", "New York", 40.71, -74.01],
  ["America/Toronto", "Toronto", 43.65, -79.38],
  ["America/Halifax", "Halifax", 44.65, -63.58],
  ["America/Sao_Paulo", "São Paulo", -23.55, -46.63],
  ["America/Argentina/Buenos_Aires", "Buenos Aires", -34.6, -58.38],
  ["Atlantic/Reykjavik", "Reykjavík", 64.15, -21.94],
  ["Europe/London", "London", 51.51, -0.13],
  ["Europe/Dublin", "Dublin", 53.35, -6.26],
  ["Europe/Lisbon", "Lisbon", 38.72, -9.14],
  ["Europe/Paris", "Paris", 48.86, 2.35],
  ["Europe/Berlin", "Berlin", 52.52, 13.4],
  ["Europe/Madrid", "Madrid", 40.42, -3.7],
  ["Europe/Rome", "Rome", 41.9, 12.5],
  ["Europe/Amsterdam", "Amsterdam", 52.37, 4.9],
  ["Europe/Stockholm", "Stockholm", 59.33, 18.07],
  ["Europe/Athens", "Athens", 37.98, 23.73],
  ["Europe/Istanbul", "Istanbul", 41.01, 28.98],
  ["Europe/Moscow", "Moscow", 55.76, 37.62],
  ["Africa/Cairo", "Cairo", 30.04, 31.24],
  ["Africa/Johannesburg", "Johannesburg", -26.2, 28.05],
  ["Africa/Lagos", "Lagos", 6.52, 3.38],
  ["Africa/Nairobi", "Nairobi", -1.29, 36.82],
  ["Asia/Dubai", "Dubai", 25.2, 55.27],
  ["Asia/Karachi", "Karachi", 24.86, 67.0],
  ["Asia/Kolkata", "Mumbai", 19.08, 72.88],
  ["Asia/Bangkok", "Bangkok", 13.76, 100.5],
  ["Asia/Singapore", "Singapore", 1.35, 103.82],
  ["Asia/Hong_Kong", "Hong Kong", 22.32, 114.17],
  ["Asia/Shanghai", "Shanghai", 31.23, 121.47],
  ["Asia/Seoul", "Seoul", 37.57, 126.98],
  ["Asia/Tokyo", "Tokyo", 35.68, 139.69],
  ["Australia/Perth", "Perth", -31.95, 115.86],
  ["Australia/Sydney", "Sydney", -33.87, 151.21],
  ["Pacific/Auckland", "Auckland", -36.85, 174.76],
];
const BY_TZ = new Map(ZONES.map(([tz, city, lat, lon]) => [tz, { city, lat, lon }]));

define("world-clocks", {
  meta: {
    label: "World clocks",
    description: "The time in up to five places, with day or night and how far ahead",
    category: "basic",
  },
  schema: {
    fields: [
      {
        key: "clocks", label: "Places", type: "list", itemLabel: "Place", addLabel: "+ Add a place",
        emptyText: "No places yet.",
        default: [
          { label: "New York", timeZone: "America/New_York" },
          { label: "London", timeZone: "Europe/London" },
          { label: "Tokyo", timeZone: "Asia/Tokyo" },
        ],
        newItem: { label: "", timeZone: "Europe/London" },
        itemTitle: (c, i) => c.label || BY_TZ.get(c.timeZone)?.city || `Place ${i + 1}`,
        itemFields: [
          { key: "timeZone", label: "Time zone", type: "select", options: ZONES.map(([tz, city]) => ({ value: tz, label: `${city} (${tz.replaceAll("_", " ")})` })) },
          { key: "label", label: "Name to show (leave blank for the city)", type: "text" },
        ],
      },
      { key: "hour12", label: "12-hour clock", type: "boolean", default: true },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "worldclocks" });
    root.appendChild(body);
    const handle = { body, widget };
    render(handle);
    handle.timer = setInterval(() => render(handle), 15000);
    return handle;
  },
  refresh(handle, widget) { if (widget) handle.widget = widget; render(handle); },
  suspend(handle) { clearInterval(handle.timer); handle.timer = null; },
  resume(handle) { if (!handle.timer) handle.timer = setInterval(() => render(handle), 15000); render(handle); },
  destroy(handle) { clearInterval(handle.timer); },
});

/** The wall-clock fields of `date` in `timeZone`. */
function wall(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute") };
}

/** "3 h ahead", "2 h 30 min behind", "same time", plus ", tomorrow"/", yesterday". */
export function offsetText(date, timeZone) {
  const here = wall(date, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const there = wall(date, timeZone);
  const asUTC = (w) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  const diffMin = Math.round((asUTC(there) - asUTC(here)) / 60000);
  const dayDiff = Math.round((Date.UTC(there.y, there.mo - 1, there.d) - Date.UTC(here.y, here.mo - 1, here.d)) / 86400000);
  let text;
  if (diffMin === 0) text = "Same time";
  else {
    const a = Math.abs(diffMin), h = Math.floor(a / 60), m = a % 60;
    text = `${h ? `${h} h` : ""}${h && m ? " " : ""}${m ? `${m} min` : ""} ${diffMin > 0 ? "ahead" : "behind"}`;
  }
  if (dayDiff > 0) text += ", tomorrow";
  else if (dayDiff < 0) text += ", yesterday";
  return text;
}

function render(handle) {
  const s = handle.widget.settings || {};
  const clocks = (s.clocks || []).filter((c) => c?.timeZone).slice(0, 5);
  if (!clocks.length) {
    handle.body.replaceChildren(stateView({
      icon: "list", title: "Add a place", body: "Choose the time zones to show in this widget's settings.",
      where: "Admin › Layout › World clocks",
    }));
    return;
  }
  const now = new Date();
  const rows = clocks.map((c) => {
    const zone = BY_TZ.get(c.timeZone);
    let day;
    try {
      day = zone ? isDaylight(now, zone.lat, zone.lon) : (() => { const h = wall(now, c.timeZone).h; return h >= 6 && h < 18; })();
    } catch { day = true; }
    let timeText = "—", period = "";
    try {
      const parts = new Intl.DateTimeFormat(undefined, {
        timeZone: c.timeZone, hour: "numeric", minute: "2-digit", hour12: s.hour12 !== false,
      }).formatToParts(now);
      timeText = parts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
      period = parts.find((p) => p.type === "dayPeriod")?.value || "";
    } catch { /* unknown zone: leave the dash */ }
    let off = "";
    try { off = offsetText(now, c.timeZone); } catch { off = c.timeZone; }
    const name = c.label?.trim() || zone?.city || c.timeZone.split("/").pop().replaceAll("_", " ");
    return el("div", { class: "wc-row" + (day ? "" : " night") }, [
      el("div", {
        class: "wc-dn", role: "img", "aria-label": day ? "Day" : "Night",
        html: day
          ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5" fill="var(--sun)"/><g stroke="var(--sun)" stroke-width="2" stroke-linecap="round"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g></svg>'
          : '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="var(--night)"/></svg>',
      }),
      el("div", { class: "wc-place" }, [el("div", { class: "wc-city" }, name), el("div", { class: "wc-off" }, off)]),
      el("div", { class: "wc-time" }, [timeText, period ? el("small", {}, period) : null]),
    ]);
  });
  // Shown only by the compact layout, which lists the first three.
  const hidden = clocks.length - 3;
  if (hidden > 0) rows.push(el("div", { class: "wc-more" }, `+${hidden} more`));
  handle.body.replaceChildren(...rows);
}
