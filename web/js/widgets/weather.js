// Weather — current conditions + 5-day forecast with ANIMATED SVG icons keyed
// by WMO weather code (rotating sun rays, drifting clouds, falling rain/snow,
// flashing lightning, sliding fog). Data from /api/data/weather (Open-Meteo,
// keyless). Location auto-resolved unless lat/lon set.
import { define } from "./registry.js";
import { el, fetchData, fmtNum } from "./dom.js";

define("weather", {
  meta: { label: "Weather", description: "Current + forecast, animated", category: "data" },
  schema: {
    fields: [
      { key: "units", label: "Units", type: "select", options: ["imperial", "metric"], default: "imperial" },
      { key: "lat", label: "Latitude (blank = auto)", type: "number" },
      { key: "lon", label: "Longitude (blank = auto)", type: "number" },
      { key: "showForecast", label: "Show 5-day forecast", type: "boolean", default: true },
      { key: "animated", label: "Animate icons", type: "boolean", default: true },
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
    const s = (widget || handle.widget).settings || {};
    try {
      const d = await fetchData("weather", clean({ units: s.units, lat: s.lat, lon: s.lon }));
      const deg = d.units === "metric" ? "°C" : "°F";
      const cur = d.current || {};
      const loc = d.location || {};
      handle.body.classList.toggle("wx-static", s.animated === false);

      const parts = [
        el("div", { class: "wx-current" }, [
          wxIcon(cur.code, "wx-icon-big"),
          el("div", { class: "wx-meta" }, [
            el("div", { class: "wx-temp" }, `${fmtNum(cur.temp)}${deg}`),
            el("div", { class: "wx-summary" }, cur.summary || "—"),
            el("div", { class: "wx-sub" }, `${loc.city || ""}  ·  feels ${fmtNum(cur.feelsLike)}${deg}  ·  ${fmtNum(cur.humidity)}% RH`),
          ]),
        ]),
      ];
      if (s.showForecast !== false) {
        parts.push(el("div", { class: "wx-forecast" }, (d.forecast || []).map((day) =>
          el("div", { class: "wx-day", title: day.summary || "" }, [
            el("div", { class: "wx-dow" }, dow(day.date)),
            wxIcon(day.code, "wx-icon-mini"),
            el("div", { class: "wx-hi" }, `${fmtNum(day.max)}°`),
            el("div", { class: "wx-lo" }, `${fmtNum(day.min)}°`),
          ])
        )));
      }
      handle.body.replaceChildren(...parts);
    } catch {
      handle.body.replaceChildren(el("div", { class: "widget-error" }, "weather unavailable"));
    }
  },
});

// ---- animated icon set --------------------------------------------------------
// One inline SVG per condition family; animation lives in dashboard.css keyed by
// class names, so `.wx-static` can switch it all off with one rule.

function kindFor(code) {
  if (code == null) return "cloud";
  if (code === 0 || code === 1) return "sun";
  if (code === 2) return "part";
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
    case "part": return `<g transform="translate(6 -4) scale(.72)">${SUN}</g>` + CLOUD("wx-drift", 4, 12, 0.95);
    case "cloud": return CLOUD("wx-drift-slow", -4, -6, 0.7) + CLOUD("wx-drift", 6, 8, 1);
    case "fog": return CLOUD("", 4, -6, 0.9) + FOGLINES;
    case "drizzle": return CLOUD("wx-drift", 4, -4, 0.95) + DROPS(3, "wx-drop wx-drop-lite");
    case "rain": return CLOUD("wx-drift", 4, -4, 0.95) + DROPS(3, "wx-drop");
    case "snow": return CLOUD("wx-drift", 4, -4, 0.95) + FLAKES(3);
    case "storm": return CLOUD("wx-drift", 4, -6, 0.95) + BOLT + DROPS(2, "wx-drop");
    default: return CLOUD("wx-drift", 4, 4, 1);
  }
}

function wxIcon(code, sizeClass) {
  const kind = kindFor(code);
  return el("div", {
    class: `wx-icon ${sizeClass} wx-${kind}`,
    html: `<svg viewBox="0 0 64 64" aria-hidden="true">${svgFor(kind)}</svg>`,
  });
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""));
}
function dow(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { weekday: "short" }); }
  catch { return iso; }
}
