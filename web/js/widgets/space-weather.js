// Space weather — planetary K-index as an animated semicircular gauge (color-
// graded quiet→storm), recent-history bars, and the aurora read. Data from NOAA
// SWPC (keyless). Display style + sections are configurable.
import { define } from "./registry.js";
import { el, fetchData, fmtNum } from "./dom.js";

const ARC_R = 40;
const ARC_LEN = Math.PI * ARC_R; // semicircle
const MAX_BARS = 12;

define("space-weather", {
  meta: { label: "Space weather", description: "Kp gauge, history & aurora", category: "data" },
  schema: {
    fields: [
      { key: "style", label: "Style", type: "select", options: ["gauge", "number"], default: "gauge" },
      { key: "showHistory", label: "Show Kp history bars", type: "boolean", default: true },
      { key: "showAurora", label: "Show aurora outlook", type: "boolean", default: true },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "spacewx" });
    root.appendChild(body);
    const handle = { body, widget };
    await this.refresh(handle, widget);
    return handle;
  },
  async refresh(handle, widget) {
    const s = (widget || handle.widget).settings || {};
    try {
      const d = await fetchData("space-weather");
      const kp = d.kp ?? 0;
      const lvl = kpLevel(kp);
      const parts = [];

      if (s.style === "number") {
        parts.push(el("div", { class: `kp-big kp-${lvl}` }, [
          el("div", { class: "kp-value" }, fmtNum(kp, 1)),
          el("div", { class: "kp-label" }, "Kp index"),
        ]));
      } else {
        parts.push(gauge(kp, lvl));
      }

      if (s.showHistory !== false && (d.history || []).length > 1) {
        parts.push(historyBars(d.history));
      }
      if (s.showAurora !== false) {
        parts.push(el("div", { class: `kp-aurora kp-${lvl}` }, d.aurora || "—"));
      }
      handle.body.replaceChildren(...parts);
    } catch {
      handle.body.replaceChildren(el("div", { class: "widget-error" }, "space weather unavailable"));
    }
  },
});

function kpLevel(kp) {
  if (kp >= 6) return "storm";
  if (kp >= 5) return "active";
  if (kp >= 4) return "unsettled";
  return "quiet";
}

// ---- semicircular gauge ---------------------------------------------------------

function gauge(kp, lvl) {
  const pct = Math.max(0, Math.min(1, kp / 9));
  const root = el("div", {
    class: `kp-gauge kp-${lvl}`,
    html: `<svg viewBox="0 0 100 58">
             <path class="kp-arc-bg" d="M10 52 A ${ARC_R} ${ARC_R} 0 0 1 90 52"/>
             <path class="kp-arc-fg" d="M10 52 A ${ARC_R} ${ARC_R} 0 0 1 90 52"
                   stroke-dasharray="${ARC_LEN.toFixed(1)}"
                   stroke-dashoffset="${ARC_LEN.toFixed(1)}"/>
             <text class="kp-gauge-val" x="50" y="46">${fmtNum(kp, 1)}</text>
             <text class="kp-gauge-cap" x="50" y="56">Kp</text>
             <text class="kp-tick" x="10" y="58">0</text>
             <text class="kp-tick" x="90" y="58" text-anchor="end">9</text>
           </svg>`,
  });
  // start empty, then tween to the value so the arc sweeps in (CSS transition)
  const fg = root.querySelector(".kp-arc-fg");
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fg.style.strokeDashoffset = (ARC_LEN * (1 - pct)).toFixed(1);
  }));
  return root;
}

// ---- history bars -----------------------------------------------------------------

function historyBars(history) {
  // thin evenly from the end so long series still fit MAX_BARS
  const step = Math.max(1, Math.ceil(history.length / MAX_BARS));
  const pts = history.filter((_, i) => (history.length - 1 - i) % step === 0).slice(-MAX_BARS);
  const wrap = el("div", { class: "kp-bars" });
  pts.forEach((p, i) => {
    const h = Math.max(8, Math.min(100, (p.kp / 9) * 100));
    wrap.appendChild(el("span", {
      class: `kp-bar kp-${kpLevel(p.kp)}`,
      title: `${fmtNum(p.kp, 1)} @ ${fmtTime(p.t)}`,
      style: { height: h + "%", animationDelay: `${i * 40}ms` },
    }));
  });
  return el("div", { class: "kp-history" }, [wrap, el("div", { class: "kp-label" }, "recent Kp")]);
}

function fmtTime(t) {
  try { return new Date(t + (t?.endsWith("Z") ? "" : "Z")).toLocaleString([], { weekday: "short", hour: "numeric" }); }
  catch { return t || ""; }
}
