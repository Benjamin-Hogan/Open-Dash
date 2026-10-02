// UV index — the number and its WHO band in the band's colour, then the one
// thing people want to know: until when is sunscreen worth it (UV 3 or more).
// Today's hours as bars: past hours grey, this hour outlined, the rest in band
// colours. After dark it talks about tomorrow. Data: /api/data/uv (Open-Meteo).
//
// Everything on the card comes from one series, the hourly forecast: the
// number "now" is interpolated from it, and so is the end of the window, so the
// words and the bars can't disagree.
import { define } from "./registry.js";
import { el, fetchData, loadInto } from "./dom.js";
import { time, parseWhen } from "./fmt.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};

// WHO bands: [upper bound (exclusive, on the rounded value), name, colour token]
export const BANDS = [[3, "Low", "--lvl-low"], [6, "Moderate", "--lvl-mod"], [8, "High", "--lvl-high"], [11, "Very high", "--lvl-vhigh"], [Infinity, "Extreme", "--lvl-ext"]];
export const band = (v) => BANDS.find(([max]) => Math.round(v ?? 0) < max);
const SUNSCREEN = 3;

define("uv-index", {
  meta: {
    label: "UV index",
    description: "UV now, its band, and until when sunscreen is worth it",
    category: "data",
    showTitle: false,
    defaultRefreshSeconds: 1800,
  },
  schema: {
    fields: [
      { key: "lat", label: "Latitude (leave blank for home)", type: "number" },
      { key: "lon", label: "Longitude (leave blank for home)", type: "number" },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "uv" });
    root.appendChild(body);
    const handle = { body, widget, data: null };
    handle.ro = new ResizeObserver(() => { if (handle.data) drawBars(handle); });
    await this.refresh(handle, widget);
    // The "now" bar and the number move through the hour.
    handle.timer = setInterval(() => { if (handle.data) render(handle); }, 5 * 60000);
    return handle;
  },
  async refresh(handle, widget) {
    if (widget) handle.widget = widget;
    const s = handle.widget.settings || {};
    await loadInto(handle, {
      load: () => fetchData("uv", clean({ lat: s.lat, lon: s.lon })),
      render: (d) => { handle.data = d; render(handle); },
      error: { title: "Can't reach the UV forecast" },
    });
  },
  suspend(handle) { clearInterval(handle.timer); handle.timer = null; },
  resume(handle) {
    if (!handle.timer) handle.timer = setInterval(() => { if (handle.data) render(handle); }, 5 * 60000);
    if (handle.data) render(handle);
  },
  destroy(handle) { clearInterval(handle.timer); handle.ro?.disconnect(); },
});

/** Hourly points [{ at: Date, uv }] for one local date ("YYYY-MM-DD"). */
function dayHours(hours, date) {
  return (hours || [])
    .filter((h) => String(h.time).startsWith(date) && h.uv != null)
    .map((h) => ({ at: parseWhen(h.time), uv: Math.max(0, h.uv) }));
}

/** Linear interpolation of the hourly series at `t`. */
export function uvAt(points, t) {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (t >= a.at && t <= b.at) return a.uv + (b.uv - a.uv) * ((t - a.at) / (b.at - a.at));
  }
  return 0;
}

/** First moment from `from` on where the series crosses `level` going the
 *  given way (falling: drops below; rising: reaches it), to the minute. */
function crossing(points, from, level, falling) {
  const end = points[points.length - 1]?.at;
  if (!end) return null;
  for (let t = new Date(from); t <= end; t = new Date(t.getTime() + 60000)) {
    const v = uvAt(points, t);
    if (falling ? v < level : v >= level) return t;
  }
  return null;
}

const round15 = (d) => new Date(Math.round(d.getTime() / 900000) * 900000);

/**
 * What the card says. Exported for tests.
 * @returns {{ value, band, message, tomorrow?: {peak, at, band}, points, day: "today"|"tomorrow" }}
 */
export function summarize(data, now = new Date()) {
  const today = data.today || localDate(now);
  const pts = dayHours(data.hours, today);
  const value = pts.length ? uvAt(pts, now) : (data.current ?? 0);
  const peakIdx = pts.reduce((m, p, i) => (p.uv > pts[m].uv ? i : m), 0);
  const rest = pts.filter((p) => p.at > now);
  const daylightLeft = rest.some((p) => p.uv >= 0.5);
  const tomorrowDate = data.days?.[1]?.date;
  if (!daylightLeft && value < 0.5 && tomorrowDate) {
    const tp = dayHours(data.hours, tomorrowDate);
    const pk = tp.reduce((m, p) => (p.uv > (m?.uv ?? -1) ? p : m), null);
    return {
      value: 0, band: band(0), day: "tomorrow", points: tp,
      tomorrow: pk ? { peak: Math.round(pk.uv), at: pk.at, band: band(pk.uv) } : null,
      message: pk ? `Peaks at ${Math.round(pk.uv)} around ${time(pk.at)}` : "",
    };
  }
  let message;
  if (value >= SUNSCREEN) {
    const until = crossing(pts, now, SUNSCREEN, true);
    message = until ? `Sunscreen until ${time(round15(until))}` : "Sunscreen all day";
  } else {
    const from = crossing(pts, now, SUNSCREEN, false);
    if (from) {
      const until = crossing(pts, from, SUNSCREEN, true);
      message = `Sunscreen ${time(round15(from))}–${until ? time(round15(until)) : "sunset"}`;
    } else if (pts.length && pts[peakIdx].uv >= SUNSCREEN && pts[peakIdx].at < now) {
      message = "Low for the rest of the day";
    } else {
      message = "No sunscreen needed today";
    }
  }
  return { value, band: band(value), message, points: pts, day: "today" };
}

function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function render(handle) {
  const now = new Date();
  const sum = summarize(handle.data, now);
  handle.sum = sum;
  const [, name, token] = sum.band;
  const night = sum.day === "tomorrow";
  handle.body.style.setProperty("--uvc", `var(${night && sum.tomorrow ? sum.tomorrow.band[2] : token})`);
  handle.body.classList.toggle("uv-night", night);
  const num = el("div", { class: "uv-num" }, String(Math.round(sum.value)));
  const head = el("div", { class: "uv-head" }, night
    ? [
      el("div", { class: "uv-cat" }, sum.tomorrow ? ["Tomorrow ", el("span", { class: "uv-band" }, sum.tomorrow.band[1])] : "Tomorrow"),
      el("div", { class: "uv-msg" }, sum.message),
    ]
    : [el("div", { class: "uv-cat" }, el("span", { class: "uv-band" }, name)), el("div", { class: "uv-msg" }, sum.message)]);
  const plot = el("div", { class: "uv-plot" });
  handle.body.replaceChildren(num, head, plot);
  handle.plot = plot;
  handle.ro.disconnect();
  handle.ro.observe(plot);
  drawBars(handle);
}

/** Hourly bars across the day's daylight, at the plot's real pixel size. */
function drawBars(handle) {
  const host = handle.plot, sum = handle.sum;
  if (!host || !sum) return;
  const W = host.clientWidth, H = host.clientHeight;
  // Daylight hours only, padded by one each side.
  let pts = sum.points;
  const lit = pts.map((p, i) => (p.uv >= 0.05 ? i : -1)).filter((i) => i >= 0);
  if (lit.length) pts = pts.slice(Math.max(0, lit[0] - 1), lit[lit.length - 1] + 2);
  if (W < 80 || H < 40 || pts.length < 2) { host.replaceChildren(); return; }
  const now = new Date();
  const base = H - 22, top = 4, n = pts.length, slot = W / n;
  const x = (i) => slot * (i + 0.5);
  const y = (v) => base - (Math.min(v, 11) / 11) * (base - top);
  const night = sum.day === "tomorrow";
  const peak = pts.reduce((m, p) => (p.uv > m.uv ? p : m), pts[0]);
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
    "aria-label": `UV ${night ? "tomorrow" : "today"}: peak ${Math.round(peak.uv)} at ${time(peak.at)}`,
  });
  pts.forEach((p, i) => {
    const hourEnd = new Date(p.at.getTime() + 3600000);
    const past = !night && hourEnd <= now;
    const current = !night && p.at <= now && now < hourEnd;
    const r = svgEl("rect", {
      x: x(i) - slot / 2 + 2, y: y(p.uv), width: Math.max(2, slot - 4), height: Math.max(2, base - y(p.uv)), rx: 3,
      class: "uv-bar" + (past ? " past" : "") + (current ? " now" : ""),
      fill: past ? "var(--past)" : `var(${band(p.uv)[2]})`,
    });
    svg.append(r);
  });
  svg.append(svgEl("line", { x1: 0, x2: W, y1: base, y2: base, class: "uv-axisline" }));
  // Ends plus a few hours between, never colliding.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 90))));
  for (let i = 0; i < n; i += every) {
    if (i > 0 && n - 1 - i < every * 0.6) continue;
    svg.append(svgEl("text", { x: i === 0 ? 0 : x(i), y: H - 3, class: "uv-axis", "text-anchor": i === 0 ? "start" : "middle" }, time(pts[i].at)));
  }
  svg.append(svgEl("text", { x: W, y: H - 3, class: "uv-axis", "text-anchor": "end" }, time(pts[n - 1].at)));
  host.replaceChildren(svg);
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""));
}
