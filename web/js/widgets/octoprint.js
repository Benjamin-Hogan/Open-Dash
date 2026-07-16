// OctoPrint — glanceable printer status. Layout mirrors weather/pi-stats:
// one hero number, quiet secondary line, metric columns. Webcam is a separate
// Image widget pointed at /webcam/?action=stream.
import { define } from "./registry.js";
import { el, fetchData, fmtNum, effectiveSettings } from "./dom.js";

define("octoprint", {
  meta: {
    label: "OctoPrint",
    description: "3D printer status, progress, filament (webcam is separate)",
    category: "data",
  },
  schema: {
    fields: [
      { key: "url", label: "OctoPrint URL", type: "text", placeholder: "http://192.168.x.x (prefer IP over .local)" },
      {
        key: "apiKey",
        label: "API key (from OctoPrint → Settings → API)",
        type: "password",
        placeholder: "Paste key for this printer…",
      },
      { key: "showTemps", label: "Show temperatures", type: "boolean", default: true },
      { key: "showFilament", label: "Show filament used", type: "boolean", default: true },
      { key: "showFlags", label: "Show connection detail", type: "boolean", default: true },
      {
        key: "urlNote",
        label: "Use the printer's LAN IP when the dashboard runs on a Pi — .local (mDNS) often fails there. For the camera, add an Image widget with http://<ip>/webcam/?action=stream.",
        type: "note",
      },
      {
        key: "apiKeyNote",
        label: "Optional if OCTOPRINT_API_KEY is set globally in API keys (shared by all printers).",
        type: "note",
      },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "octo" });
    root.appendChild(body);
    const handle = { body, widget };
    await this.refresh(handle, widget);
    return handle;
  },
  async refresh(handle, widget) {
    const w = widget || handle.widget;
    const s = effectiveSettings(w);
    const params = {};
    if (s.url) params.url = s.url;
    if (w.id) params.widgetId = w.id;
    try {
      const d = await fetchData("octoprint", params);
      if (d.needsKey) {
        handle.body.replaceChildren(el("div", { class: "widget-empty" },
          `Set ${d.env} in API keys, or add an API key in this widget's settings`));
        return;
      }
      if (!d.configured) {
        handle.body.replaceChildren(el("div", { class: "widget-empty" }, d.error || "not configured"));
        return;
      }

      const tone = stateTone(d);
      const printing = !!d.printing;
      const pct = d.completion != null ? Math.max(0, Math.min(100, d.completion)) : null;
      const hero = pct != null
        ? pct.toFixed(pct >= 99.95 || pct < 0.05 ? 0 : 1) + "%"
        : statusWord(d);

      const parts = [
        el("div", { class: "octo-top" }, [
          el("div", { class: "octo-hero " + tone }, hero),
          el("div", { class: "octo-meta" }, [
            el("div", { class: "octo-status" }, [
              el("span", { class: "octo-dot " + tone }),
              el("span", { class: "octo-state" }, statusWord(d)),
            ]),
            d.file
              ? el("div", { class: "octo-file", title: d.file }, prettyFile(d.file))
              : el("div", { class: "octo-file muted" }, "No active job"),
            s.showFlags !== false ? connectionLine(d) : null,
          ]),
        ]),
      ];

      if (pct != null) {
        parts.push(
          el("div", { class: "octo-bar" + (printing ? " live" : "") }, [
            el("div", { class: "octo-fill", style: { width: pct.toFixed(1) + "%" } }),
          ]),
        );
      }

      const metrics = [];
      if (d.timeLeft != null && (printing || d.paused || (pct != null && pct < 100))) {
        metrics.push(metric("Left", dur(d.timeLeft)));
        if (printing && d.timeLeft > 0) metrics.push(metric("Done", finishClock(d.timeLeft)));
      }
      if (d.timeElapsed != null && (printing || d.paused || (pct != null && pct > 0))) {
        metrics.push(metric("Elapsed", dur(d.timeElapsed)));
      }
      if (s.showFilament !== false && d.filament?.lengthMm != null) {
        const m = Number(d.filament.lengthMm) / 1000;
        metrics.push(metric("Filament", `${fmtNum(m, m >= 10 ? 1 : 2)} m`));
      }
      if (metrics.length) parts.push(el("div", { class: "octo-metrics" }, metrics));

      if (s.showTemps !== false && (d.tool || d.bed)) {
        parts.push(el("div", { class: "octo-temps" }, [
          d.tool ? tempCard("Tool", d.tool) : null,
          d.bed ? tempCard("Bed", d.bed) : null,
        ]));
      }

      handle.body.className = "octo tone-" + tone;
      handle.body.replaceChildren(...parts);
    } catch (err) {
      const detail = err && err.message ? String(err.message) : "";
      handle.body.replaceChildren(el("div", { class: "widget-error" },
        detail.includes("502") ? "printer unreachable" : (detail || "printer unreachable")));
    }
  },
});

function stateTone(d) {
  if (d.error) return "err";
  const s = (d.state || "").toLowerCase();
  if (d.printing || s.includes("printing")) return "printing";
  if (d.paused || s.includes("paused")) return "paused";
  if (s.includes("error") || s.includes("offline") || s.includes("closed")) return "err";
  if (d.ready || d.operational) return "ready";
  return "idle";
}

function statusWord(d) {
  if (d.error) return "Error";
  if (d.paused) return "Paused";
  if (d.printing) return "Printing";
  const s = (d.state || "").trim();
  if (!s || s === "Unknown") return d.ready ? "Ready" : "Idle";
  // OctoPrint often sends "Operational" — wall-friendlier label
  if (s.toLowerCase() === "operational") return d.ready ? "Ready" : "Connected";
  return s;
}

function connectionLine(d) {
  const conn = d.connection || {};
  const bits = [];
  if (conn.port) bits.push(conn.port.replace(/^\/dev\//, ""));
  if (d.error) bits.unshift("Offline");
  else if (!d.operational && conn.state) bits.unshift(conn.state);
  if (!bits.length) return null;
  return el("div", { class: "octo-conn" }, bits.join(" · "));
}

function prettyFile(name) {
  return String(name).replace(/\.gcode$/i, "");
}

function metric(label, value) {
  return el("div", { class: "octo-metric" }, [
    el("div", { class: "octo-metric-val" }, value),
    el("div", { class: "octo-metric-label" }, label),
  ]);
}

function tempCard(label, t) {
  const actual = t.actual == null ? "—" : `${fmtNum(t.actual)}°`;
  const target = t.target ? el("span", { class: "octo-temp-target" }, ` / ${fmtNum(t.target)}°`) : null;
  const hot = t.target && t.actual != null && Number(t.actual) > 40;
  return el("div", { class: "octo-temp" + (hot ? " hot" : "") }, [
    el("div", { class: "octo-temp-label" }, label),
    el("div", { class: "octo-temp-val" }, [actual, target]),
  ]);
}

function finishClock(seconds) {
  const finish = new Date(Date.now() + seconds * 1000);
  return finish.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function dur(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}
