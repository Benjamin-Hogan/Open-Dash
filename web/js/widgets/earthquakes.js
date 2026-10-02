// Earthquakes — USGS quakes near home. A map-free "radar": home in the middle,
// rings at half and full radius (linear), each quake placed by its true
// bearing and distance, its size growing with magnitude (energy is
// exponential, so an M4.3 looks much bigger than an M2.7). Quakes older than a
// day are rings, not dots; a new one pings a few times, then stays still. The
// headline sums up; the list gives the largest. Quiet is the usual view.
import { define } from "./registry.js";
import { el, fetchData, loadInto, ago } from "./dom.js";
import { day } from "./fmt.js";
import { cardinal } from "./wind.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const KM_PER_MI = 1.609344;

define("earthquakes", {
  meta: {
    label: "Earthquakes",
    description: "Recent earthquakes near home, from the USGS",
    category: "data",
    showTitle: false,
    defaultRefreshSeconds: 600,
  },
  schema: {
    fields: [
      { key: "radius", label: "Within (miles, or km with metric units)", type: "number", default: 500, min: 10, max: 3000 },
      { key: "minMagnitude", label: "Smallest magnitude to show", type: "select", default: "2.5", options: [
        { value: "1", label: "1.0 (every tremor, busy in quake country)" }, { value: "2.5", label: "2.5 (can be felt nearby)" },
        { value: "4", label: "4.0 (felt widely)" }, { value: "4.5", label: "4.5 (can do damage)" },
      ] },
      { key: "period", label: "Look back", type: "select", default: "week", options: [
        { value: "day", label: "The past day" }, { value: "week", label: "The past 7 days" },
      ] },
      { key: "units", label: "Units", type: "select", default: "imperial", options: [
        { value: "imperial", label: "Miles" }, { value: "metric", label: "Kilometres" },
      ] },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "quakes" });
    root.appendChild(body);
    const handle = { body, widget, data: null };
    handle.ro = new ResizeObserver(() => { if (handle.data) drawMap(handle); });
    await this.refresh(handle, widget);
    return handle;
  },
  async refresh(handle, widget) {
    if (widget) handle.widget = widget;
    const s = handle.widget.settings || {};
    const metric = s.units === "metric";
    const radiusKm = (Number(s.radius) || 500) * (metric ? 1 : KM_PER_MI);
    await loadInto(handle, {
      load: () => fetchData("earthquakes", { radiusKm: Math.round(radiusKm), minMagnitude: s.minMagnitude || "2.5", period: s.period || "week" }),
      render: (d) => { handle.data = d; render(handle); },
      error: { title: "Can't reach the USGS" },
    });
  },
  destroy(handle) { handle.ro?.disconnect(); },
});

const magClass = (m) => "m" + Math.max(2, Math.min(6, Math.floor(m)));
const STATES = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE",
  Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY",
  Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO",
  Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA",
  Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY", "Puerto Rico": "PR",
};
/** "8 km N of Black Canyon City, Arizona" → "Black Canyon City, AZ". Exported for tests. */
export function placeName(p) {
  const s = String(p || "").replace(/^\s*\d+(\.\d+)?\s*km\s+[NSEW]{1,3}\s+of\s+/i, "").trim();
  return s.replace(/,\s*([A-Za-z ]+)$/, (m, st) => (STATES[st.trim()] ? `, ${STATES[st.trim()]}` : m)) || "Unknown place";
}
const when = (ms, now) => (now - ms < 86400000 ? ago(ms, now) : day(new Date(ms), new Date(now)));

function dist(km, metric) {
  return metric ? `${Math.round(km)} km` : `${Math.round(km / KM_PER_MI)} mi`;
}

function render(handle) {
  const s = handle.widget.settings || {};
  const metric = s.units === "metric";
  const d = handle.data;
  const now = Date.now();
  const quakes = d.quakes || [];
  const span = d.period === "day" ? "today" : "this week";
  const radiusText = dist(d.radiusKm, metric);
  if (!quakes.length) {
    handle.body.classList.add("quiet");
    handle.body.replaceChildren(el("div", { class: "eq-quiet" }, [
      el("span", { class: "ok-badge", html: CHECK }),
      el("div", {}, [
        el("div", { class: "eq-big" }, "No earthquakes nearby"),
        el("div", { class: "eq-sub" }, `M${Number(d.minMagnitude).toFixed(1)} or more, ${radiusText}, past ${d.period === "day" ? "day" : "7 days"}`),
      ]),
    ]));
    return;
  }
  handle.body.classList.remove("quiet");
  const largest = [...quakes].sort((a, b) => b.mag - a.mag || b.time - a.time);
  const top = largest[0];
  const head = el("div", { class: "eq-head" }, [
    el("div", { class: "eq-big" }, quakes.length === 1 ? `M${top.mag.toFixed(1)} near ${placeName(top.place)}` : `${quakes.length} earthquakes ${span}`),
    el("div", { class: "eq-sub" }, quakes.length === 1
      ? `${when(top.time, now)} · ${dist(top.distanceKm, metric)} ${cardinal(top.bearing)}`
      : `Largest M${top.mag.toFixed(1)}, ${when(top.time, now)}`),
  ]);
  const list = el("div", { class: "eq-list" }, largest.slice(0, 3).map((q) => el("div", { class: `eq-row ${magClass(q.mag)}` }, [
    el("span", { class: "eq-mag" }, q.mag.toFixed(1)),
    el("div", { class: "eq-row-text" }, [
      el("div", { class: "eq-place" }, placeName(q.place)),
      el("div", { class: "eq-meta" }, `${dist(q.distanceKm, metric)} ${cardinal(q.bearing)} · ${when(q.time, now)}`),
    ]),
  ])));
  const map = el("div", { class: "eq-map" });
  handle.body.replaceChildren(map, el("div", { class: "eq-side" }, [head, list]));
  handle.map = map;
  handle.ro.disconnect();
  handle.ro.observe(map);
  drawMap(handle);
}

function drawMap(handle) {
  const host = handle.map, d = handle.data;
  if (!host || !d?.quakes?.length) return;
  const S = Math.min(host.clientWidth, host.clientHeight);
  if (S < 80) { host.replaceChildren(); return; }
  const metric = handle.widget.settings?.units === "metric";
  const c = S / 2, R = c - 2, now = Date.now();
  const svg = svgEl("svg", { viewBox: `0 0 ${S} ${S}`, width: S, height: S, role: "img", "aria-label": `Map of ${d.quakes.length} earthquakes around home` });
  for (const f of [0.5, 1]) {
    svg.append(svgEl("circle", { cx: c, cy: c, r: R * f, class: "eq-rng" }));
    svg.append(svgEl("text", { x: c + R * f * Math.SQRT1_2 + 3, y: c + R * f * Math.SQRT1_2 + 14, class: "eq-rngl" },
      f === 1 ? dist(d.radiusKm, metric) : String(Math.round((metric ? d.radiusKm : d.radiusKm / KM_PER_MI) / 2))));
  }
  // Oldest first, so the newest are drawn on top.
  for (const q of [...d.quakes].reverse()) {
    const rad = Math.min(26, 4 * 10 ** (0.3 * (q.mag - 2.5)));
    const a = (q.bearing * Math.PI) / 180;
    // Very close to home: nudged outward along the true bearing, off the house.
    const r = Math.max((R * q.distanceKm) / d.radiusKm, 20 + rad);
    const x = c + r * Math.sin(a), y = c - r * Math.cos(a);
    const g = svgEl("g", { class: magClass(q.mag) });
    if (now - q.time < 10 * 60000) g.append(svgEl("circle", { cx: x, cy: y, r: rad, class: "eq-ping" }));
    g.append(svgEl("circle", { cx: x, cy: y, r: rad, class: "eq-dot" + (now - q.time > 86400000 ? " old" : "") }));
    svg.append(g);
  }
  const home = svgEl("path", { d: `M${c} ${c - 9} L${c + 8} ${c - 2} V${c + 8} H${c - 8} V${c - 2} Z`, class: "eq-home" });
  svg.append(home, svgEl("text", { x: c + 14, y: c + 5, class: "eq-homel" }, "Home"));
  host.replaceChildren(svg);
}
