// Tides — NOAA predictions for the nearest station to home (or a chosen one).
// Which way the water's moving and when it turns, today's curve with each
// high and low labelled, the past in grey, and the height now. The curve is
// drawn between NOAA's highs and lows with the standard cosine method, and the
// headline and "now" height come from that same curve.
//
// Predictions don't go out of date: when a refresh fails but the saved ones
// still cover the next day, the card keeps drawing normally.
import { define } from "./registry.js";
import { el, fetchData, markOk, markFailed, stateView } from "./dom.js";
import { time, span, minus } from "./fmt.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
const ARROW = '<svg viewBox="0 0 24 24"><path d="M12 4v16M5 11l7-7 7 7"/></svg>';

define("tides", {
  meta: {
    label: "Tides",
    description: "Today's tide curve, highs and lows, and which way the water is moving (US coasts)",
    category: "data",
    showTitle: false,
    defaultRefreshSeconds: 3 * 3600,
  },
  schema: {
    fields: [
      { key: "station", label: "NOAA station number (leave blank for the nearest to home)", type: "text", placeholder: "9410170",
        help: "Find one at tidesandcurrents.noaa.gov (the number in the station's page address)." },
      { key: "name", label: "Name to show (leave blank for the station's)", type: "text", placeholder: "Ocean Beach" },
      { key: "units", label: "Units", type: "select", default: "imperial", options: [
        { value: "imperial", label: "Feet" }, { value: "metric", label: "Metres" },
      ] },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "tides" });
    root.appendChild(body);
    const handle = { body, widget, data: null };
    handle.ro = new ResizeObserver(() => { if (handle.data?.station) draw(handle); });
    await this.refresh(handle, widget);
    handle.timer = setInterval(() => { if (handle.data?.station) render(handle); }, 5 * 60000);
    return handle;
  },
  async refresh(handle, widget) {
    if (widget) handle.widget = widget;
    const s = handle.widget.settings || {};
    try {
      const d = await fetchData("tides", clean({ station: s.station?.trim(), units: s.units === "metric" ? "metric" : "english" }));
      handle.data = d;
      render(handle);
      markOk(handle);
    } catch {
      const evs = handle.data?.events || [];
      const last = evs.length ? new Date(evs[evs.length - 1].time) : null;
      if (last && last - Date.now() > 24 * 3600000) { render(handle); return; }
      markFailed(handle, "Can't reach NOAA", undefined, () => this.refresh(handle));
    }
  },
  suspend(handle) { clearInterval(handle.timer); handle.timer = null; },
  resume(handle) {
    if (!handle.timer) handle.timer = setInterval(() => { if (handle.data?.station) render(handle); }, 5 * 60000);
    if (handle.data?.station) render(handle);
  },
  destroy(handle) { clearInterval(handle.timer); handle.ro?.disconnect(); },
});

/** Height at time t (ms) between NOAA's highs and lows. Exported for tests. */
export function tideAt(events, t) {
  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i], b = events[i + 1];
    if (t >= a.t && t <= b.t) return a.height + (b.height - a.height) * (1 - Math.cos((Math.PI * (t - a.t)) / (b.t - a.t))) / 2;
  }
  return null;
}

const prepare = (d) => (d.events || []).map((e) => ({ ...e, t: new Date(e.time).getTime() })).sort((a, b) => a.t - b.t);
const fmtH = (v, unit) => `${minus(v.toFixed(1))} ${unit}`;

function render(handle) {
  const d = handle.data;
  const s = handle.widget.settings || {};
  if (!d.station) {
    handle.body.replaceChildren(stateView({
      icon: "link",
      title: d.reason === "bad-station" ? "Tides: station not found" : "Tides: no station near home",
      body: d.reason === "bad-station" ? "Check the station number in this widget's settings." : "Choose a station in this widget's settings.",
      where: "Admin › Layout › Tides",
    }));
    return;
  }
  const evs = prepare(d), now = Date.now();
  const hNow = tideAt(evs, now);
  const next = evs.find((e) => e.t > now);
  if (hNow == null || !next) {
    handle.body.replaceChildren(stateView({ tone: "error", icon: "offline", title: "No tide predictions for today" }));
    return;
  }
  const unit = d.units || "ft";
  const rising = next.high;
  const where = s.name?.trim() || d.station.name;
  handle.body.replaceChildren(
    el("div", { class: "td-head" }, [
      el("div", { class: "td-head-text" }, [
        el("div", { class: "td-big" }, [
          el("span", { class: "td-arrow" + (rising ? "" : " down"), html: ARROW }),
          `${rising ? "Rising" : "Falling"} until ${time(new Date(next.t))}`,
        ]),
        el("div", { class: "td-sub" }, `${rising ? "High" : "Low"} ${fmtH(next.height, unit)} in ${span(next.t - now)} · ${where}`),
      ]),
      el("div", { class: "td-now" }, [el("b", {}, fmtH(hNow, unit)), el("span", {}, "now")]),
    ]),
    (handle.plot = el("div", { class: "td-plot" })),
  );
  handle.evs = evs;
  handle.ro.disconnect();
  handle.ro.observe(handle.plot);
  draw(handle);
}

function draw(handle) {
  const host = handle.plot, evs = handle.evs, unit = handle.data.units || "ft";
  if (!host || !evs) return;
  const W = host.clientWidth, H = host.clientHeight;
  if (W < 120 || H < 60) { host.replaceChildren(); return; }
  const now = new Date();
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t1 = t0 + 86400000;
  const nowT = now.getTime();
  const inDay = evs.filter((e) => e.t > t0 && e.t < t1);
  const samples = [];
  for (let t = t0; t <= t1; t += 450000) { const v = tideAt(evs, t); if (v != null) samples.push([t, v]); }
  if (samples.length < 2) { host.replaceChildren(); return; }
  const vs = samples.map((p) => p[1]);
  const lo = Math.min(...vs), hi = Math.max(...vs), range = Math.max(0.5, hi - lo);
  // Labels sit above each high and each low (a trough leaves room above it),
  // so the curve can use nearly all the height.
  const top = 38, base = H - 22, bottom = base - 6;
  const x = (t) => ((t - t0) / 86400000) * W;
  const y = (v) => top + (1 - (v - lo) / range) * (bottom - top);
  const path = (a, b) => samples.filter(([t]) => t >= a && t <= b).map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const nowV = tideAt(evs, nowT);
  const mid = `L${x(nowT).toFixed(1)} ${y(nowV).toFixed(1)}`;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
    "aria-label": `Tide today: ${inDay.map((e) => `${e.high ? "high" : "low"} ${e.height.toFixed(1)} ${unit} at ${time(new Date(e.t))}`).join(", ")}`,
  });
  const past = path(t0, nowT) + mid, future = `M${x(nowT).toFixed(1)} ${y(nowV).toFixed(1)} ` + path(nowT, t1).replace(/^M/, "L");
  svg.append(svgEl("path", { d: `${past} L${x(nowT)} ${base} L0 ${base} Z`, class: "td-water past" }));
  svg.append(svgEl("path", { d: `${future} L${W} ${base} L${x(nowT)} ${base} Z`, class: "td-water" }));
  svg.append(svgEl("path", { d: past, class: "td-line past" }));
  svg.append(svgEl("path", { d: future, class: "td-line" }));
  const half = 38;
  // Future turns are labelled first; a label that would collide with one
  // already placed is left off (the past gives way).
  const placed = [];
  for (const e of [...inDay].sort((a, b) => (a.t < nowT) - (b.t < nowT) || a.t - b.t)) {
    let lx = x(e.t);
    // Keep clear of the now line and the card's edges.
    if (Math.abs(lx - x(nowT)) < half + 6) lx = x(nowT) + (lx < x(nowT) ? -(half + 6) : half + 6);
    lx = Math.max(half, Math.min(W - half, lx));
    const lift = e.high ? 0 : 10; // a trough's sides rise; lift its label clear of them
    const ly = y(e.height) - 9 - lift;
    if (placed.some((p) => Math.abs(p.x - lx) < half * 2 + 4 && Math.abs(p.y - ly) < 36)) continue;
    placed.push({ x: lx, y: ly });
    const cls = e.t < nowT ? " past" : "";
    svg.append(svgEl("text", { x: lx, y: ly - 17, class: "td-hl" + cls }, fmtH(e.height, unit)));
    svg.append(svgEl("text", { x: lx, y: ly, class: "td-hlt" + cls }, time(new Date(e.t))));
  }
  svg.append(svgEl("line", { x1: x(nowT), x2: x(nowT), y1: y(nowV), y2: base, class: "td-nowl" }));
  svg.append(svgEl("circle", { cx: x(nowT), cy: y(nowV), r: 7, class: "td-nowd" }));
  svg.append(svgEl("line", { x1: 0, x2: W, y1: base, y2: base, class: "td-axl" }));
  const ticks = W < 420 ? [[0, "Midnight"], [12, "Noon"]] : [[0, "Midnight"], [6, "6 AM"], [12, "Noon"], [18, "6 PM"]];
  for (const [h, label] of ticks) {
    const text = h === 0 || h === 12 ? label : time(new Date(t0 + h * 3600000));
    svg.append(svgEl("text", { x: x(t0 + h * 3600000), y: H - 3, class: "td-ax", "text-anchor": h === 0 ? "start" : "middle" }, text));
  }
  host.replaceChildren(svg);
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""));
}

