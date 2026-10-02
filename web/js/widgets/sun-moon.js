// Sun & Moon — "how long until dark?" as the headline, where the sun is in
// today's daylight, how long the day is and whether it's growing, and
// tonight's moon as it looks. Computed on the display from the home location
// (astro.js); the only fetch is the location itself.
import { define } from "./registry.js";
import { el, fetchData, loadInto } from "./dom.js";
import { sunTimes, moonPhase, moonPath } from "./astro.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

define("sun-moon", {
  meta: {
    label: "Sun & Moon",
    description: "Sunrise, sunset, length of day and tonight's moon",
    category: "data",
    showTitle: false,
    // Picks up tomorrow's sunrise and sunset; the minute timer moves the arc.
    defaultRefreshSeconds: 3600,
  },
  schema: {
    fields: [
      { key: "lat", label: "Latitude (leave blank for home)", type: "number" },
      { key: "lon", label: "Longitude (leave blank for home)", type: "number" },
      { key: "showMoon", label: "Show the moon", type: "boolean", default: true },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "sunmoon" });
    root.appendChild(body);
    const handle = { body, widget, loc: null };
    handle.ro = new ResizeObserver(() => { if (handle.loc) drawArc(handle); });
    await this.refresh(handle, widget);
    handle.timer = setInterval(() => { if (handle.loc) render(handle); }, 60000);
    return handle;
  },
  async refresh(handle, widget) {
    if (widget) handle.widget = widget;
    const s = handle.widget.settings || {};
    const custom = s.lat != null && s.lon != null && s.lat !== "" && s.lon !== "";
    await loadInto(handle, {
      // The weather service's sunrise and sunset (the same cached request the
      // Weather widget makes) are what everything else on the wall agrees
      // with; astro.js fills in when they're unavailable.
      load: async () => {
        try {
          const w = await fetchData("weather", custom ? { lat: s.lat, lon: s.lon } : {});
          const loc = { lat: w.location.lat, lon: w.location.lon, days: w.forecast || [], offset: w.utcOffsetSeconds };
          remember(loc);
          return loc;
        } catch {
          // Everything here can be computed, so being offline is no reason to
          // go blank or look out of date: keep what we have, else use the
          // configured or last known location.
          if (handle.loc) return handle.loc;
          if (custom) return { lat: Number(s.lat), lon: Number(s.lon), days: null };
          try {
            const l = await fetchData("location");
            remember(l);
            return { ...l, days: null };
          } catch {
            const last = recall();
            if (last) return { ...last, days: null };
            throw new Error("no location yet");
          }
        }
      },
      render: (loc) => { handle.loc = loc; render(handle); },
      error: { title: "Can't find the home location" },
    });
  },
  suspend(handle) { clearInterval(handle.timer); handle.timer = null; },
  resume(handle) {
    if (!handle.timer) handle.timer = setInterval(() => { if (handle.loc) render(handle); }, 60000);
    if (handle.loc) render(handle);
  },
  destroy(handle) { clearInterval(handle.timer); handle.ro?.disconnect(); },
});

const time = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const shortDate = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** "17 min", "2 h 5 min", "9 h" */
function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// The last good location, kept on the display so a reboot without network
// still draws the right sky.
const STORE = "sun-moon:location";
function remember(loc) {
  try { localStorage.setItem(STORE, JSON.stringify({ lat: loc.lat, lon: loc.lon })); } catch { /* storage off */ }
}
function recall() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || "null");
    return Number.isFinite(v?.lat) && Number.isFinite(v?.lon) ? v : null;
  } catch { return null; }
}

/** A location-local "YYYY-MM-DDTHH:MM" from the weather service, as a Date. */
function fromLocal(iso, offsetSeconds) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || "");
  if (!m || offsetSeconds == null) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - offsetSeconds * 1000);
}

/** Sunrise/sunset for the location-local day `dayOffset` days from now:
 *  the weather service's when it has that day, else computed. */
function sunFor(loc, now, dayOffset) {
  const at = new Date(now.getTime() + dayOffset * 86400000);
  const computed = sunTimes(at, loc.lat, loc.lon);
  if (!loc.days?.length || loc.offset == null) return computed;
  const localDate = new Date(at.getTime() + loc.offset * 1000).toISOString().slice(0, 10);
  const day = loc.days.find((d) => d.date === localDate);
  const sunrise = fromLocal(day?.sunrise, loc.offset), sunset = fromLocal(day?.sunset, loc.offset);
  return sunrise && sunset ? { ...computed, sunrise, sunset, polar: null } : computed;
}

function render(handle) {
  const { lat, lon } = handle.loc;
  const s = handle.widget.settings || {};
  const now = new Date();
  const today = sunFor(handle.loc, now, 0);
  const tomorrow = sunFor(handle.loc, now, 1);
  // Day-length change from the model on both days: the difference is precise
  // even where the absolute times are a minute or two off.
  const modelToday = sunTimes(now, lat, lon);
  const yesterday = sunTimes(new Date(now.getTime() - 86400000), lat, lon);

  let headline;
  if (today.polar === "day") headline = "The sun doesn't set today";
  else if (today.polar === "night") headline = "The sun doesn't rise today";
  else if (now < today.sunrise) headline = `Sunrise in ${duration(today.sunrise - now)}`;
  else if (now < today.sunset) headline = `Sunset in ${duration(today.sunset - now)}`;
  else headline = tomorrow.sunrise ? `Sunrise in ${duration(tomorrow.sunrise - now)}` : "Night";

  // Where we are in today's daylight (0 at sunrise, 1 at sunset; null at night).
  handle.progress = today.sunrise && now >= today.sunrise && now <= today.sunset
    ? (now - today.sunrise) / (today.sunset - today.sunrise) : null;

  const dayLen = today.sunrise ? today.sunset - today.sunrise : null;
  const prevLen = yesterday.sunrise ? yesterday.sunset - yesterday.sunrise : null;
  const modelLen = modelToday.sunrise ? modelToday.sunset - modelToday.sunrise : null;
  let change = "";
  if (modelLen != null && prevLen != null) {
    const diffMin = Math.round((modelLen - prevLen) / 60000);
    change = diffMin === 0 ? ", about the same as yesterday"
      : `, ${Math.abs(diffMin)} min ${diffMin < 0 ? "shorter" : "longer"} than yesterday`;
  }

  const arc = el("div", { class: "sm-arc" });
  const sun = el("div", { class: "sm-sun" }, [
    el("div", { class: "sm-head" }, headline),
    arc,
    el("div", {}, [
      today.sunrise ? el("div", { class: "sm-times" }, [
        el("div", {}, ["Sunrise", el("b", {}, time(today.sunrise))]),
        el("div", { class: "sm-set" }, ["Sunset", el("b", {}, time(today.sunset))]),
      ]) : null,
      dayLen != null ? el("div", { class: "sm-day" }, [
        el("b", {}, duration(dayLen).replace(" min", " m")), ` of daylight${change}`,
      ]) : null,
    ]),
  ]);

  const parts = [sun];
  if (s.showMoon !== false) {
    const m = moonPhase(now);
    const lit = Math.round(m.illumination * 100);
    const svg = svgEl("svg", { viewBox: "0 0 100 100", role: "img", "aria-label": `${m.name}, ${lit} percent lit` });
    const disc = svgEl("g");
    // Southern hemisphere sees the moon mirrored.
    if (lat < 0) disc.setAttribute("transform", "translate(100 0) scale(-1 1)");
    disc.append(
      svgEl("circle", { cx: 50, cy: 50, r: 44, class: "sm-moon-dark" }),
      svgEl("path", { d: moonPath(m.illumination, m.waxing, 50, 50, 44), class: "sm-moon-lit" }),
      svgEl("circle", { cx: 50, cy: 50, r: 44, class: "sm-moon-rim" }),
    );
    svg.append(disc);
    const next = [["New moon", m.nextNew], ["Full moon", m.nextFull]].sort((a, b) => a[1] - b[1]);
    parts.push(el("div", { class: "sm-moon" }, [
      svg,
      el("div", { class: "sm-phase" }, m.name),
      el("div", { class: "sm-lit" }, `${lit}% lit`),
      ...next.map(([name, when]) => el("div", { class: "sm-next" }, `${name} ${shortDate(when)}`)),
    ]));
  }
  handle.body.classList.toggle("no-moon", s.showMoon === false);
  handle.body.replaceChildren(...parts);
  handle.arc = arc;
  handle.ro.disconnect();
  handle.ro.observe(arc);
  drawArc(handle);
}

/** The day arc, drawn at its real pixel size. */
function drawArc(handle) {
  const host = handle.arc;
  if (!host) return;
  const W = host.clientWidth, H = host.clientHeight;
  if (W < 40 || H < 30) { host.replaceChildren(); return; }
  const cx = W / 2, base = H - 6, r = Math.max(10, Math.min(W / 2 - 14, H - 16));
  const at = (p) => { const a = Math.PI * (1 - p); return [cx + r * Math.cos(a), base - r * Math.sin(a)]; };
  const p = handle.progress;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
    "aria-label": p == null ? "The sun is down" : `${Math.round(p * 100)} percent of today's daylight has passed`,
  });
  const [x0, y0] = at(0), [x1, y1] = at(1);
  svg.append(svgEl("line", { x1: 4, x2: W - 4, y1: base, y2: base, class: "sm-horizon" }));
  svg.append(svgEl("path", { d: `M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}`, class: "sm-track" }));
  if (p != null) {
    const [px, py] = at(p);
    svg.append(svgEl("path", { d: `M${x0} ${y0} A${r} ${r} 0 0 1 ${px} ${py}`, class: "sm-done" }));
    svg.append(svgEl("circle", { cx: px, cy: py, r: 9, class: "sm-sundot" }));
  }
  host.replaceChildren(svg);
}

export { duration };
