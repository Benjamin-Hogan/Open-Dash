// Clock — zero-config, no API. Big glanceable time + date, optional timezone.
//
// Built for reading across a room: no leading zero ("5:17", not "05:17"), the
// AM/PM and seconds set smaller beside the time so it never wraps, and the
// type sized from the card itself (container units) rather than the viewport.
import { define } from "./registry.js";
import { el } from "./dom.js";

define("clock", {
  // A clock face already says what it is; no title strip by default.
  meta: { label: "Clock", description: "Time and date", category: "basic", showTitle: false },
  schema: {
    fields: [
      { key: "timeZone", label: "Time zone (leave blank for the display's own)", type: "text", placeholder: "America/Phoenix" },
      { key: "hour12", label: "12-hour clock", type: "boolean", default: true },
      // Off by default: a ticking second hand pulls the eye across the room.
      { key: "showSeconds", label: "Show seconds", type: "boolean", default: false },
      { key: "showDate", label: "Show the date", type: "boolean", default: true },
    ],
  },
  async mount(root, widget) {
    const main = el("span", { class: "clock-main" });
    const sec = el("span", { class: "clock-sec" });
    const period = el("span", { class: "clock-period" });
    const time = el("div", { class: "clock-time" }, [main, sec, period]);
    const date = el("div", { class: "clock-date" });
    root.appendChild(el("div", { class: "clock" }, [time, date]));
    const handle = { main, sec, period, date, widget };
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
  const hour12 = s.hour12 !== false;
  // Seconds were on by default before this setting existed; only an explicit
  // true shows them now.
  const showSeconds = s.showSeconds === true;
  const opts = { hour: "numeric", minute: "2-digit", second: "2-digit", hour12 };
  const dateOpts = { weekday: "long", month: "long", day: "numeric" };
  if (s.timeZone) { opts.timeZone = s.timeZone; dateOpts.timeZone = s.timeZone; }
  const now = new Date();
  let parts;
  try {
    parts = new Intl.DateTimeFormat(undefined, opts).formatToParts(now);
  } catch {
    // A bad time zone name: fall back to the display's own clock.
    delete opts.timeZone; delete dateOpts.timeZone;
    parts = new Intl.DateTimeFormat(undefined, opts).formatToParts(now);
  }
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  handle.main.textContent = `${get("hour")}:${get("minute")}`;
  handle.sec.textContent = showSeconds ? `:${get("second")}` : "";
  handle.period.textContent = hour12 ? get("dayPeriod") : "";
  handle.date.hidden = s.showDate === false;
  try {
    handle.date.textContent = now.toLocaleDateString(undefined, dateOpts);
  } catch {
    handle.date.textContent = now.toLocaleDateString();
  }
}
