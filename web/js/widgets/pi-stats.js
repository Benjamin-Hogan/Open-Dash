// Pi stats — animated ring gauges (CPU / memory / temp) with green→amber→red
// levels, a live CPU sparkline built from client-side history, and load/uptime
// chips. Data from /api/data/pi-stats. Gauges tween via CSS transitions on
// stroke-dashoffset, so the skeleton is built ONCE and only values move.
import { define } from "./registry.js";
import { el, fetchData, fmtNum } from "./dom.js";

const R = 34;                       // gauge radius in its 80×80 viewBox
const CIRC = 2 * Math.PI * R;       // stroke circumference
const SPARK_POINTS = 60;            // sparkline history length

define("pi-stats", {
  meta: { label: "Pi stats", description: "CPU, memory, temp gauges + graph", category: "system" },
  schema: {
    fields: [
      { key: "showSpark", label: "Show CPU history graph", type: "boolean", default: true },
      { key: "tempMax", label: "Temp gauge max °C", type: "number", default: 85 },
    ],
  },
  async mount(root, widget) {
    const s = widget.settings || {};
    const body = el("div", { class: "pistats" });
    const rings = el("div", { class: "pi-rings" });
    const cpu = ring("CPU"), mem = ring("Memory"), temp = ring("Temp");
    rings.append(cpu.root, mem.root, temp.root);
    body.appendChild(rings);

    let spark = null;
    if (s.showSpark !== false) {
      spark = el("div", {
        class: "pi-spark",
        html: `<svg viewBox="0 0 100 28" preserveAspectRatio="none">
                 <path class="pi-spark-fill" d=""/>
                 <path class="pi-spark-line" d=""/>
               </svg>`,
      });
      body.appendChild(spark);
    }
    const foot = el("div", { class: "pi-foot" });
    body.appendChild(foot);
    root.appendChild(body);

    const handle = { body, widget, cpu, mem, temp, spark, foot, history: [] };
    await this.refresh(handle, widget);
    return handle;
  },
  async refresh(handle, widget) {
    const s = (widget || handle.widget).settings || {};
    try {
      const d = await fetchData("pi-stats");
      const memory = d.memory || {};
      const tempMax = Number(s.tempMax) || 85;

      setRing(handle.cpu, d.cpuPercent, 100, d.cpuPercent != null ? `${fmtNum(d.cpuPercent, 0)}%` : "—", 60, 85);
      setRing(handle.mem, memory.percent, 100, memory.percent != null ? `${fmtNum(memory.percent, 0)}%` : "—", 70, 88);
      setRing(handle.temp, d.tempC, tempMax, d.tempC != null ? `${fmtNum(d.tempC, 0)}°` : "—",
        tempMax * 0.7, tempMax * 0.88);

      // CPU history sparkline (survives across refreshes via the handle)
      if (handle.spark && d.cpuPercent != null) {
        handle.history.push(d.cpuPercent);
        if (handle.history.length > SPARK_POINTS) handle.history.shift();
        drawSpark(handle.spark, handle.history);
      }

      handle.foot.replaceChildren(...[
        chip("Load", d.load1 != null ? fmtNum(d.load1, 2) : "—"),
        memory.usedMb != null ? chip("RAM", `${fmtNum(memory.usedMb / 1024, 1)} / ${fmtNum(memory.totalMb / 1024, 1)} GB`) : null,
        chip("Up", d.uptimeSeconds != null ? fmtUptime(d.uptimeSeconds) : "—"),
      ].filter(Boolean));
    } catch {
      handle.body.replaceChildren(el("div", { class: "widget-error" }, "stats unavailable"));
    }
  },
});

// ---- ring gauge ----------------------------------------------------------------

function ring(label) {
  const root = el("div", {
    class: "pi-ring",
    html: `<svg viewBox="0 0 80 80">
             <circle class="pi-ring-bg" cx="40" cy="40" r="${R}"/>
             <circle class="pi-ring-fg" cx="40" cy="40" r="${R}"
                     stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"/>
             <text class="pi-ring-val" x="40" y="45">—</text>
           </svg>`,
  });
  root.appendChild(el("div", { class: "pi-ring-cap" }, label));
  return { root, fg: root.querySelector(".pi-ring-fg"), val: root.querySelector(".pi-ring-val") };
}

function setRing(r, value, max, text, warnAt, hotAt) {
  const pct = value != null && max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  r.fg.style.strokeDashoffset = String(CIRC * (1 - pct));
  r.val.textContent = text;
  r.root.classList.toggle("lvl-warn", value != null && value >= warnAt && value < hotAt);
  r.root.classList.toggle("lvl-hot", value != null && value >= hotAt);
  r.root.classList.toggle("lvl-na", value == null);
}

// ---- sparkline -------------------------------------------------------------------

function drawSpark(spark, history) {
  if (history.length < 2) return;
  const w = 100, h = 28, pad = 2;
  const step = w / (SPARK_POINTS - 1);
  const x0 = w - (history.length - 1) * step; // right-aligned: newest at the right edge
  const pts = history.map((v, i) => {
    const x = x0 + i * step;
    const y = h - pad - (Math.max(0, Math.min(100, v)) / 100) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  spark.querySelector(".pi-spark-line").setAttribute("d", "M" + pts.join(" L"));
  spark.querySelector(".pi-spark-fill").setAttribute(
    "d", `M${x0.toFixed(1)},${h} L` + pts.join(" L") + ` L${w},${h} Z`);
}

// ---- bits ------------------------------------------------------------------------

function chip(label, value) {
  return el("span", { class: "pi-chip" }, [
    el("span", { class: "pi-chip-label" }, label), " ", String(value),
  ]);
}

function fmtUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
