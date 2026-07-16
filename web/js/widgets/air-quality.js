// Air Quality (US AQI) — keyless via Open-Meteo, uses resolved geolocation.
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

define("air-quality", {
  meta: { label: "Air quality", description: "US AQI + pollutants", category: "data" },
  schema: { fields: [] },
  async mount(root, widget) {
    const body = el("div", { class: "aqi" });
    root.appendChild(body);
    const handle = { body, widget };
    await this.refresh(handle);
    return handle;
  },
  async refresh(handle) {
    try {
      const d = await fetchData("air-quality");
      const p = d.pollutants || {};
      handle.body.replaceChildren(
        el("div", { class: "aqi-gauge " + level(d.aqi) }, [
          el("div", { class: "aqi-value" }, d.aqi == null ? "—" : fmtNum(d.aqi, 0)),
          el("div", { class: "aqi-cat" }, d.category || "—"),
        ]),
        el("div", { class: "aqi-sub" }, [
          el("span", {}, `PM2.5 ${fmtNum(p.pm2_5, 0)}`),
          el("span", {}, `PM10 ${fmtNum(p.pm10, 0)}`),
          el("span", {}, `O₃ ${fmtNum(p.ozone, 0)}`),
        ]),
        el("div", { class: "aqi-loc" }, [d.location?.city, d.location?.region].filter(Boolean).join(", "))
      );
    } catch {
      handle.body.replaceChildren(el("div", { class: "widget-error" }, "air quality unavailable"));
    }
  },
});
