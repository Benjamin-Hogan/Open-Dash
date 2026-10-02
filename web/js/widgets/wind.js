// Wind — which way and how hard. A vane sits inside the ring on the side the
// wind comes FROM and points in, labelled with that side ("SW"), matching the
// words "From the southwest". The Beaufort word is the headline; gusts are a
// second number that turns amber only when they're well over the wind. The
// next hours as speed + compass letters. Same data as Weather (cached).
import { define } from "./registry.js";
import { el, fetchData, fmtNum, loadInto } from "./dom.js";
import { time, parseWhen } from "./fmt.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const NAMES = { N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest" };
export const cardinal = (deg) => COMPASS[Math.round((((deg ?? 0) % 360) + 360) % 360 / 45) % 8];

// Beaufort, in plain words, by mph.
const WORDS = [[1, "Calm"], [4, "Nearly calm"], [8, "Light breeze"], [13, "Gentle breeze"], [19, "Breezy"], [25, "Windy"], [32, "Very windy"], [39, "Near gale"], [47, "Gale"], [Infinity, "Storm-force"]];
export const beaufort = (mph) => WORDS.find(([max]) => (mph ?? 0) < max)[1];

define("wind", {
  meta: {
    label: "Wind",
    description: "Wind direction and speed on a compass, with gusts and the next hours",
    category: "data",
    showTitle: false,
    defaultRefreshSeconds: 900,
  },
  schema: {
    fields: [
      { key: "units", label: "Units", type: "select", default: "imperial", options: [
        { value: "imperial", label: "mph" }, { value: "metric", label: "km/h" },
      ] },
      { key: "lat", label: "Latitude (leave blank for home)", type: "number" },
      { key: "lon", label: "Longitude (leave blank for home)", type: "number" },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "wind" });
    root.appendChild(body);
    const handle = { body, widget };
    await this.refresh(handle, widget);
    return handle;
  },
  async refresh(handle, widget) {
    if (widget) handle.widget = widget;
    const s = handle.widget.settings || {};
    await loadInto(handle, {
      load: () => fetchData("weather", clean({ units: s.units, lat: s.lat, lon: s.lon })),
      render: (d) => render(handle, d),
      error: { title: "Can't reach the weather service" },
    });
  },
});

function dial(w, small) {
  const dir = cardinal(w.from);
  const svg = svgEl("svg", { viewBox: "0 0 100 100", role: "img", "aria-label": `Wind from the ${NAMES[dir]} at ${fmtNum(w.speed)} ${w.unit}` });
  svg.append(svgEl("circle", { cx: 50, cy: 50, r: 44, class: "wd-ring" }));
  for (let a = 0; a < 360; a += 30) {
    if (a === 0 && !small) continue;
    const r = (a * Math.PI) / 180;
    svg.append(svgEl("line", { x1: 50 + 40 * Math.sin(r), y1: 50 - 40 * Math.cos(r), x2: 50 + 44 * Math.sin(r), y2: 50 - 44 * Math.cos(r), class: "wd-tick" }));
  }
  if (!small) svg.append(svgEl("text", { x: 50, y: 13, class: "wd-n" }, "N"));
  if (w.from != null && w.speed >= 1) {
    const g = svgEl("g", { transform: `rotate(${w.from} 50 50)` });
    g.append(svgEl("path", { d: "M50 22 L42 6.5 Q50 9.5 58 6.5 Z", class: "wd-vane" }));
    svg.append(g);
    if (!small) {
      const r = (w.from * Math.PI) / 180;
      svg.append(svgEl("text", { x: 50 + 61 * Math.sin(r), y: 50 - 61 * Math.cos(r), class: "wd-vl" }, dir));
    }
  }
  svg.append(svgEl("text", { x: 50, y: small ? 57 : 55, class: "wd-spd", style: `font-size:${small ? 24 : 26}px` }, fmtNum(w.speed)));
  if (!small) svg.append(svgEl("text", { x: 50, y: 69, class: "wd-unit" }, w.unit));
  return svg;
}

function render(handle, d) {
  const cur = d.current || {};
  const unit = cur.windUnit === "kmh" ? "km/h" : "mph";
  const toMph = (v) => (unit === "km/h" ? v / 1.609 : v);
  const w = { from: cur.windDir, speed: cur.wind ?? 0, unit };
  const gust = cur.gust;
  const strong = gust != null && toMph(gust - w.speed) >= 10;
  const dir = cardinal(w.from);
  const calm = w.speed < 1;
  // The next hours, every two, starting from the next hour.
  const hours = (d.hourly || []).slice(1).filter((_, i) => i % 2 === 0).slice(0, 6);
  handle.body.replaceChildren(
    el("div", { class: "wd-dial" }, dial(w, false)),
    el("div", { class: "wd-dial wd-dial-small" }, dial(w, true)),
    el("div", { class: "wd-text" }, [
      el("div", { class: "wd-word" }, beaufort(toMph(w.speed))),
      el("div", { class: "wd-from" }, calm ? "No wind to speak of" : `From the ${NAMES[dir]}`),
      el("div", { class: "wd-from-short" }, calm ? "Calm" : `${fmtNum(w.speed)} ${unit} from the ${dir}`),
      gust != null ? el("div", { class: "wd-gust-short" }, `Gusts ${fmtNum(gust)} ${unit}`) : null,
    ]),
    gust != null ? el("div", { class: "wd-gust" + (strong ? " strong" : "") }, [el("b", {}, fmtNum(gust)), el("span", {}, `gusts, ${unit}`)]) : null,
    hours.length ? el("div", { class: "wd-hours" }, hours.map((h) => el("div", {}, [
      el("b", {}, fmtNum(h.wind)), el("em", {}, h.wind >= 1 ? cardinal(h.windDir) : ""), el("span", {}, time(parseWhen(h.time))),
    ]))) : null,
  );
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""));
}
