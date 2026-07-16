// Clock — zero-config, no API. Big glanceable time + date, optional timezone.
import { define } from "./registry.js";
import { el } from "./dom.js";

define("clock", {
  meta: { label: "Clock", description: "Time and date", category: "basic" },
  schema: {
    fields: [
      { key: "timeZone", label: "Time zone (IANA, blank = local)", type: "text", placeholder: "America/Phoenix" },
      { key: "hour12", label: "12-hour clock", type: "boolean", default: true },
      { key: "showSeconds", label: "Show seconds", type: "boolean", default: true },
    ],
  },
  async mount(root, widget) {
    const time = el("div", { class: "clock-time" });
    const date = el("div", { class: "clock-date" });
    root.appendChild(el("div", { class: "clock" }, [time, date]));
    const handle = { time, date, widget };
    tick(handle);
    handle.interval = setInterval(() => tick(handle), 1000);
    return handle;
  },
  refresh(handle) {
    tick(handle);
  },
  suspend(handle) {
    clearInterval(handle.interval);
    handle.interval = null;
  },
  resume(handle) {
    if (!handle.interval) handle.interval = setInterval(() => tick(handle), 1000);
  },
  destroy(handle) {
    clearInterval(handle.interval);
    handle.interval = null;
  },
});

function tick(handle) {
  const s = handle.widget.settings || {};
  const opts = { hour: "2-digit", minute: "2-digit", hour12: s.hour12 !== false };
  if (s.showSeconds !== false) opts.second = "2-digit";
  if (s.timeZone) opts.timeZone = s.timeZone;
  const dateOpts = { weekday: "long", month: "long", day: "numeric" };
  if (s.timeZone) dateOpts.timeZone = s.timeZone;
  const now = new Date();
  try {
    handle.time.textContent = now.toLocaleTimeString(undefined, opts);
    handle.date.textContent = now.toLocaleDateString(undefined, dateOpts);
  } catch {
    handle.time.textContent = now.toLocaleTimeString();
    handle.date.textContent = now.toLocaleDateString();
  }
}
