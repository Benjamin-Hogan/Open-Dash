// Air Quality (US AQI) — keyless via Open-Meteo, uses home/IP geolocation
// unless lat/lon are set on the widget.
import { define } from "./registry.js";
import { el, fetchData, fmtNum } from "./dom.js";

function level(aqi) {
  if (aqi == null) return "na";
  if (aqi <= 50) return "good";
  if (aqi <= 100) return "moderate";
  if (aqi <= 150) return "usg";
  if (aqi <= 200) return "unhealthy";
  if (aqi <= 300) return "vunhealthy";
  return "hazardous";
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""));
}

define("air-quality", {
  meta: { label: "Air quality", description: "US AQI + pollutants", category: "data" },
  schema: {
    fields: [
      { key: "lat", label: "Latitude (blank = home/auto)", type: "number" },
      { key: "lon", label: "Longitude (blank = home/auto)", type: "number" },
      { key: "showNo2", label: "Show NO₂", type: "boolean", default: false },
      { key: "cacheTtlSeconds", label: "Server cache TTL seconds (blank = default)", type: "number" },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "aqi" });
    root.appendChild(body);
    const handle = { body, widget };
    await this.refresh(handle);
    return handle;
  },
  async refresh(handle) {
    const s = handle.widget.settings || {};
    try {
      const d = await fetchData("air-quality", clean({
        lat: s.lat, lon: s.lon, cacheTtl: s.cacheTtlSeconds,
      }));
      const p = d.pollutants || {};
      const pollutants = [
        el("span", {}, `PM2.5 ${fmtNum(p.pm2_5, 0)}`),
        el("span", {}, `PM10 ${fmtNum(p.pm10, 0)}`),
        el("span", {}, `O₃ ${fmtNum(p.ozone, 0)}`),
      ];
      if (s.showNo2) pollutants.push(el("span", {}, `NO₂ ${fmtNum(p.no2, 0)}`));
      handle.body.replaceChildren(
        el("div", { class: "aqi-gauge " + level(d.aqi) }, [
          el("div", { class: "aqi-value" }, d.aqi == null ? "—" : fmtNum(d.aqi, 0)),
          el("div", { class: "aqi-cat" }, d.category || "—"),
        ]),
        el("div", { class: "aqi-sub" }, pollutants),
        el("div", { class: "aqi-loc" }, [d.location?.city, d.location?.region].filter(Boolean).join(", "))
      );
    } catch {
      handle.body.replaceChildren(el("div", { class: "widget-error" }, "air quality unavailable"));
    }
  },
});
