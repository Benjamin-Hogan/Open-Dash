// Weather — current conditions, today's range, five days and the next hours,
// with animated SVG icons keyed by WMO weather code. Data from
// /api/data/weather (Open-Meteo, keyless). Location is the home location
// unless the widget sets lat/lon.
//
// One markup for every card size; container queries in dashboard.css choose
// what shows: a small card is the glance (now, high/low, wind), a medium one
// adds five days, a large one adds the next hours too. Only the lead icon
// animates — a dozen spinning suns on an always-on screen is noise.
import { define } from "./registry.js";
import { el, fetchData, fmtNum, loadInto } from "./dom.js";

define("weather", {
  meta: { defaultRefreshSeconds: 900, label: "Weather", description: "Now, today's range, five days and the next hours", category: "data", showTitle: false },
  schema: {
    fields: [
      { key: "units", label: "Units", type: "select", options: [
        { value: "imperial", label: "Fahrenheit, mph" },
        { value: "metric", label: "Celsius, km/h" },
      ], default: "imperial" },
      { key: "lat", label: "Latitude (leave blank for home)", type: "number" },
      { key: "lon", label: "Longitude (leave blank for home)", type: "number" },
      { key: "showForecast", label: "Show five days when there's room", type: "boolean", default: true },
      { key: "showHours", label: "Show the next hours when there's room", type: "boolean", default: true },
      { key: "animated", label: "Animate the main icon", type: "boolean", default: true },
      { key: "cacheTtlSeconds", label: "Fetch new data at most every (seconds)", type: "number" },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "weather" });
    root.appendChild(body);
    const handle = { body, widget };
    await this.refresh(handle, widget);
    return handle;
  },
  async refresh(handle, widget) {
    if (widget) handle.widget = widget;
    const s = handle.widget.settings || {};
    await loadInto(handle, {
      load: () => fetchData("weather", clean({
        units: s.units, lat: s.lat, lon: s.lon, cacheTtl: s.cacheTtlSeconds,
      })),
      render: (d) => render(handle, d, s),
      error: { title: "Can't reach the weather service" },
    });
  },
});

function render(handle, d, s) {
  const cur = d.current || {};
  const today = (d.forecast || [])[0] || {};
  const windUnit = cur.windUnit === "kmh" ? "km/h" : "mph";
  handle.body.classList.toggle("wx-static", s.animated === false);
  handle.body.classList.toggle("wx-no-days", s.showForecast === false);
  handle.body.classList.toggle("wx-no-hours", s.showHours === false);

  const fact = (label, value) => el("div", { class: "wx-fact" }, [`${label} `, el("b", {}, value)]);
  const now = el("div", { class: "wx-now" }, [
    wxIcon(cur.code, cur.isDay !== false, "wx-icon-big"),
    el("div", { class: "wx-meta" }, [
      el("div", { class: "wx-temp" }, `${fmtNum(cur.temp)}°`),
      el("div", { class: "wx-summary" }, cur.summary || "—"),
      d.location?.city ? el("div", { class: "wx-loc" }, d.location.city) : null,
    ]),
    el("div", { class: "wx-facts" }, [
      el("div", { class: "wx-fact wx-range" }, [
        el("span", { class: "wx-hi-lbl" }, "High "), el("b", {}, `${fmtNum(today.max)}°`),
        el("span", { class: "wx-sep" }, " · "),
        el("span", { class: "wx-lo-lbl" }, "Low "), el("b", {}, `${fmtNum(today.min)}°`),
      ]),
      // Small cards stack these instead of the combined range line.
      el("div", { class: "wx-fact wx-only-small" }, ["High ", el("b", {}, `${fmtNum(today.max)}°`)]),
      el("div", { class: "wx-fact wx-only-small" }, ["Low ", el("b", {}, `${fmtNum(today.min)}°`)]),
      el("div", { class: "wx-fact wx-feels" }, ["Feels like ", el("b", {}, `${fmtNum(cur.feelsLike)}°`)]),
      fact("Wind", `${fmtNum(cur.wind)} ${windUnit}`),
      // Only when it matters; "Rain Dry" said nothing.
      wet(cur.rain) ? el("div", { class: "wx-fact wx-rain-now" }, ["Rain chance ", el("b", {}, `${cur.rain}%`)]) : null,
    ]),
  ]);

  // "Now" is the current reading (so it matches the lead icon and temperature),
  // then the next six hours, each with its own icon (night after sunset).
  const nowCol = { time: null, temp: cur.temp, code: cur.code, isDay: cur.isDay, rain: cur.rain };
  const hours = el("div", { class: "wx-hours" }, [nowCol, ...(d.hourly || []).slice(1, 7)].map((h, i) =>
    el("div", { class: "wx-hour" }, [
      el("span", { class: "wx-h-time" }, i === 0 ? "Now" : hourLabel(h.time)),
      wxIcon(h.code, h.isDay, "wx-icon-mini"),
      el("b", {}, `${fmtNum(h.temp)}°`),
      // Only when it matters: a row of "0%" says nothing.
      el("span", { class: "wx-h-rain" }, wet(h.rain) ? `${h.rain}%` : ""),
    ])));

  const days = el("div", { class: "wx-days" }, (d.forecast || []).slice(0, 5).map((day) =>
    el("div", { class: "wx-day" + (day.date === d.today ? " today" : ""), title: day.summary || "" }, [
      el("div", { class: "wx-dow" }, day.date === d.today ? "Today" : dow(day.date)),
      wxIcon(day.code, true, "wx-icon-mini"),
      el("div", { class: "wx-hl" }, [el("b", {}, `${fmtNum(day.max)}°`), el("span", {}, `${fmtNum(day.min)}°`)]),
      el("div", { class: "wx-pp" + (wet(day.rain) ? "" : " dry") }, rainText(day.rain)),
    ])));

  handle.body.replaceChildren(now, hours, days);
}

// Under this, a rain chance is noise (Open-Meteo reports 1% all the time).
export const RAIN_MIN = 10;
const wet = (p) => p != null && p >= RAIN_MIN;

function rainText(p) {
  return wet(p) ? `${p}%` : "Dry";
}

// ---- animated icon set --------------------------------------------------------
// One inline SVG per condition family; animation lives in dashboard.css keyed by
// class names, so `.wx-static` can switch it all off with one rule.

function kindFor(code, isDay) {
  if (code == null) return "cloud";
  if (code === 0 || code === 1) return isDay ? "sun" : "moon";
  if (code === 2) return isDay ? "part" : "part-night";
  if (code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloud";
}

const SUN = `
  <g class="wx-rays">
    <g stroke="var(--wx-sun)" stroke-width="3" stroke-linecap="round">
      <line x1="32" y1="6"  x2="32" y2="13"/><line x1="32" y1="51" x2="32" y2="58"/>
      <line x1="6"  y1="32" x2="13" y2="32"/><line x1="51" y1="32" x2="58" y2="32"/>
      <line x1="13.6" y1="13.6" x2="18.6" y2="18.6"/><line x1="45.4" y1="45.4" x2="50.4" y2="50.4"/>
      <line x1="13.6" y1="50.4" x2="18.6" y2="45.4"/><line x1="45.4" y1="18.6" x2="50.4" y2="13.6"/>
    </g>
  </g>
  <circle cx="32" cy="32" r="11" fill="var(--wx-sun)"/>`;

const MOON = `<path fill="var(--night)" d="M42 44a16 16 0 0 1-20-24A18 18 0 1 0 45.5 41.5 16 16 0 0 1 42 44z"/>`;

const CLOUD = (cls = "", dx = 0, dy = 0, scale = 1) => `
  <g class="wx-cloud ${cls}" transform="translate(${dx} ${dy}) scale(${scale})">
    <path fill="var(--wx-cloud)" d="M20 46a9.5 9.5 0 0 1-1-18.9A13.5 13.5 0 0 1 45 23.5 10 10 0 0 1 45 46z"/>
  </g>`;

const DROPS = (n, cls) => {
  let out = `<g class="wx-precip">`;
  for (let i = 0; i < n; i++) {
    const x = 22 + i * 10;
    out += `<line class="${cls}" style="animation-delay:${i * 0.45}s" x1="${x}" y1="50" x2="${x - 2}" y2="57" stroke="var(--wx-rain)" stroke-width="2.6" stroke-linecap="round"/>`;
  }
  return out + `</g>`;
};

const FLAKES = (n) => {
  let out = `<g class="wx-precip">`;
  for (let i = 0; i < n; i++) {
    const x = 22 + i * 10;
    out += `<circle class="wx-flake" style="animation-delay:${i * 0.6}s" cx="${x}" cy="52" r="2.2" fill="var(--wx-snow)"/>`;
  }
  return out + `</g>`;
};

const BOLT = `<polygon class="wx-bolt" points="30,44 38,44 33,52 40,52 27,63 31,54 25,54" fill="var(--wx-sun)"/>`;

const FOGLINES = `
  <g stroke="var(--wx-cloud)" stroke-width="3" stroke-linecap="round" opacity=".8">
    <line class="wx-fog1" x1="16" y1="48" x2="46" y2="48"/>
    <line class="wx-fog2" x1="22" y1="54" x2="50" y2="54"/>
    <line class="wx-fog1" x1="18" y1="60" x2="42" y2="60"/>
  </g>`;

function svgFor(kind) {
  switch (kind) {
    case "sun": return SUN;
    case "moon": return MOON;
    case "part": return `<g transform="translate(6 -4) scale(.72)">${SUN}</g>` + CLOUD("wx-drift", 4, 12, 0.95);
    case "part-night": return `<g transform="translate(8 -6) scale(.72)">${MOON}</g>` + CLOUD("wx-drift", 4, 12, 0.95);
    case "cloud": return CLOUD("wx-drift-slow", -4, -6, 0.7) + CLOUD("wx-drift", 6, 8, 1);
    case "fog": return CLOUD("", 4, -6, 0.9) + FOGLINES;
    case "drizzle": return CLOUD("wx-drift", 4, -4, 0.95) + DROPS(3, "wx-drop wx-drop-lite");
    case "rain": return CLOUD("wx-drift", 4, -4, 0.95) + DROPS(3, "wx-drop");
    case "snow": return CLOUD("wx-drift", 4, -4, 0.95) + FLAKES(3);
    case "storm": return CLOUD("wx-drift", 4, -6, 0.95) + BOLT + DROPS(2, "wx-drop");
    default: return CLOUD("wx-drift", 4, 4, 1);
  }
}

function wxIcon(code, isDay, sizeClass) {
  const kind = kindFor(code, isDay !== false);
  return el("div", {
    class: `wx-icon ${sizeClass} wx-${kind}`,
    html: `<svg viewBox="0 0 64 64" aria-hidden="true">${svgFor(kind)}</svg>`,
  });
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""));
}

/** Weekday for a "YYYY-MM-DD" calendar date. Parsed as a local date: `new
 *  Date("2026-10-01")` is UTC midnight, which is the previous evening anywhere
 *  west of Greenwich — that's why every day used to be labelled one early. */
function dow(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
}

/** "9 PM" from a location-local "YYYY-MM-DDTHH:MM" (read as wall-clock time). */
export function hourLabel(iso) {
  const h = Number(String(iso).slice(11, 13));
  if (Number.isNaN(h)) return "";
  return new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });
}

export { wxIcon, dow };
