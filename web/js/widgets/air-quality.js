// Air quality (US AQI) — keyless via Open-Meteo, home location unless lat/lon
// are set. A gauge with the official AQI bands, the category in words, what it
// means for people, and the pollutant driving it — colour is never the only
// signal.
import { define } from "./registry.js";
import { el, fetchData, fmtNum, loadInto } from "./dom.js";

// Official US AQI bands: [upper bound, key, label, what it means].
const BANDS = [
  [50, "good", "Good", "Air quality is good. A great day to be outside."],
  [100, "moderate", "Moderate", "Fine for most people. If you're unusually sensitive, take it easy outdoors."],
  [150, "usg", "Unhealthy for sensitive groups", "Children, older adults and people with asthma should limit long outdoor effort."],
  [200, "unhealthy", "Unhealthy", "Everyone should cut back on long or heavy outdoor effort."],
  [300, "vunhealthy", "Very unhealthy", "Avoid long outdoor effort; sensitive groups should stay indoors."],
  [Infinity, "hazardous", "Hazardous", "Stay indoors and keep windows closed."],
];
const GAUGE_MAX = 300;

export function band(aqi) {
  if (aqi == null) return null;
  return BANDS.find(([hi]) => aqi <= hi);
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""));
}

define("air-quality", {
  meta: { defaultRefreshSeconds: 1800, label: "Air quality", description: "US air quality index with what it means", category: "data" },
  schema: {
    fields: [
      { key: "lat", label: "Latitude (leave blank for home)", type: "number" },
      { key: "lon", label: "Longitude (leave blank for home)", type: "number" },
      { key: "showNo2", label: "Show nitrogen dioxide", type: "boolean", default: false },
      { key: "cacheTtlSeconds", label: "Fetch new data at most every (seconds)", type: "number" },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "aqi" });
    root.appendChild(body);
    const handle = { body, widget };
    await this.refresh(handle, widget);
    return handle;
  },
  async refresh(handle, widget) {
    if (widget) handle.widget = widget;
    const s = handle.widget.settings || {};
    await loadInto(handle, {
      load: () => fetchData("air-quality", clean({ lat: s.lat, lon: s.lon, cacheTtl: s.cacheTtlSeconds })),
      render: (d) => render(handle, d, s),
      error: { title: "Can't reach the air quality service" },
    });
  },
});

function render(handle, d, s) {
  const b = band(d.aqi);
  const p = d.pollutants || {};
  const pm = [
    p.pm2_5 != null ? `PM2.5 ${fmtNum(p.pm2_5)}` : null,
    p.pm10 != null ? `PM10 ${fmtNum(p.pm10)}` : null,
    s.showNo2 && p.no2 != null ? `NO₂ ${fmtNum(p.no2)}` : null,
  ].filter(Boolean);
  handle.body.className = `aqi aqi-${b?.[1] || "na"}`;
  handle.body.replaceChildren(
    el("div", { class: "aqi-gauge", html: gauge(d.aqi) }),
    el("div", { class: "aqi-text" }, [
      // Small cards hide the gauge and show the number here instead.
      el("div", { class: "aqi-num" }, d.aqi == null ? "—" : String(Math.round(d.aqi))),
      el("div", { class: "aqi-cat" }, b ? b[2] : "No reading"),
      el("div", { class: "aqi-msg" }, b ? b[3] : "The air quality service didn't return a value."),
      d.mainPollutant ? el("div", { class: "aqi-main" }, ["Main pollutant: ", el("b", {}, d.mainPollutant)]) : null,
      pm.length ? el("div", { class: "aqi-pm" }, `${pm.join("  ·  ")} µg/m³`) : null,
    ]),
  );
}

/** Semicircle 0–300 with the official band colours and three readable ticks. */
function gauge(aqi) {
  const cx = 90, cy = 90, r = 68;
  const pt = (v, rr = r) => {
    const a = Math.PI * (1 - Math.min(v, GAUGE_MAX) / GAUGE_MAX);
    return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)];
  };
  const arcs = [[0, 50, "good"], [50, 100, "moderate"], [100, 150, "usg"], [150, 200, "unhealthy"], [200, 300, "vunhealthy"]]
    .map(([a, b, k]) => {
      const [x0, y0] = pt(a + 1.5), [x1, y1] = pt(b - 1.5);
      return `<path class="aqi-band aqi-band-${k}" d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}"/>`;
    }).join("");
  const ticks = [[0, "middle"], [100, "middle"], [300, "middle"]].map(([v, anchor]) => {
    // The ends sit below the arc's tips, clear of the bands.
    const [x, y] = v === 100 ? pt(v, r + 18) : pt(v, r);
    if (v !== 100) return `<text class="aqi-tick" x="${x.toFixed(1)}" y="${(y + 24).toFixed(1)}" text-anchor="${anchor}">${v === 300 ? "300+" : v}</text>`;
    return `<text class="aqi-tick" x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="${anchor}">${v === 300 ? "300+" : v}</text>`;
  }).join("");
  const needle = aqi == null ? "" : (() => {
    const [nx, ny] = pt(aqi, r - 14);
    return `<line class="aqi-needle" x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"/><circle class="aqi-hub" cx="${cx}" cy="${cy}" r="6"/>`;
  })();
  const label = aqi == null ? "No reading" : `Air quality index ${Math.round(aqi)}`;
  return `<svg viewBox="-4 -6 188 132" role="img" aria-label="${label}">${arcs}${ticks}${needle}
    <text class="aqi-value" x="${cx}" y="${cy + 36}" text-anchor="middle">${aqi == null ? "—" : Math.round(aqi)}</text></svg>`;
}
