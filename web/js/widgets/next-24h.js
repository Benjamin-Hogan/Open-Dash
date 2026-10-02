// Next 24 hours — temperature as a line, chance of rain as bars, and one
// sentence that answers "do I need an umbrella?" for exactly the window shown.
// Same data as Weather (/api/data/weather, cached), so no extra requests.
import { define } from "./registry.js";
import { el, fetchData, fmtNum, loadInto } from "./dom.js";
import { hourLabel, RAIN_MIN } from "./weather.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};

define("next-24h", {
  meta: { defaultRefreshSeconds: 900,
    label: "Next 24 hours",
    description: "Temperature and chance of rain hour by hour, with a one-line summary",
    category: "data",
    showTitle: false,
  },
  schema: {
    fields: [
      { key: "units", label: "Units", type: "select", options: [
        { value: "imperial", label: "Fahrenheit" },
        { value: "metric", label: "Celsius" },
      ], default: "imperial" },
      { key: "lat", label: "Latitude (leave blank for home)", type: "number" },
      { key: "lon", label: "Longitude (leave blank for home)", type: "number" },
    ],
  },
  async mount(root, widget) {
    const head = el("div", { class: "h24-head" });
    const plot = el("div", { class: "h24-plot" });
    const body = el("div", { class: "h24" }, [head, plot]);
    root.appendChild(body);
    const handle = { body, head, plot, widget, data: null };
    // Redraw at the plot's real pixel size whenever the card changes size.
    handle.ro = new ResizeObserver(() => { if (handle.data) draw(handle); });
    handle.ro.observe(plot);
    await this.refresh(handle, widget);
    return handle;
  },
  async refresh(handle, widget) {
    if (widget) handle.widget = widget;
    const s = handle.widget.settings || {};
    await loadInto(handle, {
      load: () => fetchData("weather", clean({ units: s.units, lat: s.lat, lon: s.lon })),
      render: (d) => {
        handle.data = d;
        // loadInto may have replaced the body's children with an error state.
        if (!handle.body.contains(handle.plot)) handle.body.replaceChildren(handle.head, handle.plot);
        draw(handle);
      },
      error: { title: "Can't reach the weather service" },
    });
  },
  destroy(handle) {
    handle.ro?.disconnect();
  },
});

function draw(handle) {
  const hours = (handle.data.hourly || []).filter((h) => h.temp != null);
  // "Now" is the current reading, the same one the Weather widget shows; the
  // first hourly slot is the top of the hour and can be a couple of degrees off.
  const cur = handle.data.current;
  if (hours.length && cur?.temp != null) hours[0] = { ...hours[0], temp: cur.temp };
  if (hours.length < 2) {
    handle.head.replaceChildren(el("div", { class: "h24-sum" }, "No hourly forecast available"));
    handle.plot.replaceChildren();
    return;
  }
  const { headline, detail } = summarize(hours, handle.data.today);
  handle.head.replaceChildren(
    el("div", { class: "h24-sum" }, headline),
    el("div", { class: "h24-detail" }, detail),
  );

  const W = handle.plot.clientWidth, H = handle.plot.clientHeight;
  if (W < 40 || H < 40) return;
  const padL = 10, padR = 40, top = 22, axis = H - 26;
  const n = hours.length - 1;
  const x = (i) => padL + (i / n) * (W - padL - padR);
  const temps = hours.map((h) => h.temp);
  const tMin = Math.min(...temps), tMax = Math.max(...temps);
  const span = Math.max(4, tMax - tMin);
  const yT = (t) => top + (1 - (t - tMin) / span) * Math.max(10, axis - top - 46);
  const yR = (p) => axis - (p / 100) * (axis - top - 10);

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
    "aria-label": `${headline}. ${detail}`,
  });
  // 50% guide for the rain bars — only when there are bars, or a dry day's
  // dashed line reads as a temperature gridline.
  if (hours.some((h) => h.rain >= RAIN_MIN)) {
    svg.append(svgEl("line", { x1: padL, x2: W - padR + 6, y1: yR(50), y2: yR(50), class: "h24-guide" }));
    svg.append(svgEl("text", { x: W - padR + 10, y: yR(50) + 5, class: "h24-axis" }, "50%"));
  }

  const bw = Math.max(4, (W - padL - padR) / n - 3);
  hours.forEach((h, i) => {
    if (!(h.rain >= RAIN_MIN)) return;
    svg.append(svgEl("rect", { x: x(i) - bw / 2, y: yR(h.rain), width: bw, height: axis - yR(h.rain), rx: 2, class: "h24-bar" }));
  });

  const pts = temps.map((t, i) => [x(i), yT(t)]);
  svg.append(svgEl("path", { d: monotonePath(pts), class: "h24-line" }));
  svg.append(svgEl("circle", { cx: pts[0][0], cy: pts[0][1], r: 5, class: "h24-dot" }));

  // Label now, the low and the high — not every point.
  const label = (i, dy) => svg.append(svgEl("text", {
    x: Math.min(Math.max(x(i), padL + 14), W - padR - 14), y: yT(temps[i]) + dy,
    "text-anchor": i === 0 ? "start" : "middle", class: "h24-temp",
  }, `${fmtNum(temps[i])}°`));
  const lo = temps.indexOf(tMin), hi = temps.indexOf(tMax);
  label(0, -12);
  // A short plot has no room under the line for the low.
  if (lo !== 0 && H >= 110) label(lo, 26);
  if (hi !== 0 && Math.abs(hi - lo) > 1) label(hi, -12);

  const peak = hours.reduce((m, h, i) => ((h.rain ?? 0) > (hours[m].rain ?? 0) ? i : m), 0);
  if (hours[peak].rain >= RAIN_MIN) {
    svg.append(svgEl("text", { x: x(peak), y: yR(hours[peak].rain) - 7, "text-anchor": "middle", class: "h24-peak" }, `${hours[peak].rain}%`));
  }

  svg.append(svgEl("line", { x1: padL, x2: W - padR, y1: axis, y2: axis, class: "h24-axisline" }));
  // Fewer labels as the card narrows, so they never collide; small cards get
  // just the ends.
  const step = W < 380 ? n : W < 520 ? 6 : 3;
  for (let i = 0; i <= n; i += step) {
    svg.append(svgEl("line", { x1: x(i), x2: x(i), y1: axis, y2: axis + 4, class: "h24-axisline" }));
    svg.append(svgEl("text", {
      x: x(i), y: H - 4, class: "h24-axis",
      "text-anchor": i === 0 ? "start" : i >= n ? "end" : "middle",
    }, i === 0 ? "Now" : hourLabel(hours[i].time)));
  }
  handle.plot.replaceChildren(svg);
}

/**
 * One sentence for the window shown. Looks for the stretch of hours around the
 * wettest one and names it ("Showers possible 1–4 PM tomorrow"); otherwise
 * "Dry for the next 24 hours". The detail line gives the peak and the range.
 */
export function summarize(hours, today) {
  const temps = hours.map((h) => h.temp).filter((t) => t != null);
  const range = `Low ${fmtNum(Math.min(...temps))}°, high ${fmtNum(Math.max(...temps))}°.`;
  const WET = 20;
  let peak = -1;
  hours.forEach((h, i) => { if ((h.rain ?? 0) >= WET && (peak < 0 || h.rain > hours[peak].rain)) peak = i; });
  if (peak < 0) return { headline: "Dry for the next 24 hours", detail: range };

  let a = peak, b = peak;
  while (a > 0 && (hours[a - 1].rain ?? 0) >= WET) a--;
  while (b < hours.length - 1 && (hours[b + 1].rain ?? 0) >= WET) b++;
  const max = hours[peak].rain;
  const codes = hours.slice(a, b + 1).map((h) => h.code ?? 0);
  const what = codes.some((c) => c >= 95) ? "Storms"
    : codes.some((c) => (c >= 71 && c <= 77) || c === 85 || c === 86) ? "Snow"
    : max >= 60 ? "Rain" : "Showers";
  const how = max >= 60 ? "likely" : "possible";
  const when = a === 0 && b === hours.length - 1 ? "all day"
    : a === b ? `around ${hourLabel(hours[a].time)} ${dayWord(hours[a].time, today)}`
    : `${spanLabel(hours[a].time, hours[b].time)} ${dayWord(hours[a].time, today)}`;
  const before = a > 0 ? (dayWord(hours[0].time, today) === "tonight" ? " Dry tonight." : " Dry until then.") : "";
  return { headline: `${what} ${how} ${a === 0 ? "now" : when}`.trim(), detail: `Up to ${max}% chance.${before} ${range}` };
}

/** "1–4 PM" when both ends share AM/PM, else "11 AM–2 PM". */
function spanLabel(t0, t1) {
  const a = hourLabel(t0), b = hourLabel(t1);
  const [an, ap] = a.split(" "), [bn, bp] = b.split(" ");
  return ap && ap === bp ? `${an}–${bn} ${bp}` : `${a}–${b}`;
}

/** "today" / "tonight" / "tomorrow" / "overnight" relative to the location's date. */
function dayWord(iso, today) {
  const date = String(iso).slice(0, 10), hour = Number(String(iso).slice(11, 13));
  if (date === today) return hour >= 18 ? "tonight" : "today";
  return hour < 6 ? "overnight" : "tomorrow";
}

/**
 * Smooth path through points without overshoot (monotone cubic,
 * Fritsch–Carlson): a hump in the data stays a hump, and flat runs stay flat
 * instead of wobbling between whole-degree readings.
 */
export function monotonePath(pts) {
  const n = pts.length;
  if (n < 2) return "";
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    dy.push(pts[i + 1][1] - pts[i][1]);
    m.push(dy[i] / dx[i]);
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
    if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(pts[i][0] + h).toFixed(1)} ${(pts[i][1] + t[i] * h).toFixed(1)}`
      + ` ${(pts[i + 1][0] - h).toFixed(1)} ${(pts[i + 1][1] - t[i + 1] * h).toFixed(1)}`
      + ` ${pts[i + 1][0].toFixed(1)} ${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""));
}
