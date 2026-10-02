// The one set of formatting rules the newer widgets share, so "4:55 PM",
// "Sunday" and "1 h 5 min" read the same on every card.
//
//   Times   "4:55 PM"; ":00" dropped ("1 PM"); a no-break space so "8 AM"
//           never splits across lines.
//   Days    Today, Tomorrow, Yesterday, the weekday within six days either
//           way ("Sunday"), then "Wed 14 Oct".
//   Spans   "25 min", "1 h 5 min", "2 h", "3 days".
//   Names   no-break hyphens, so "drop-off" doesn't break at the hyphen.

const NBSP = " ";

/** "4:55 PM", "1 PM" (or "16:55" where the locale uses 24-hour time). */
export function time(d, opts = {}) {
  const parts = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", ...opts }).formatToParts(d);
  const twelve = parts.some((p) => p.type === "dayPeriod");
  const minute = parts.find((p) => p.type === "minute")?.value;
  return parts
    // ":00" goes only on a 12-hour clock; "16:00" stays as it is.
    .filter((p, i) => !(twelve && minute === "00" && (p.type === "minute" || (p.type === "literal" && parts[i + 1]?.type === "minute"))))
    .map((p) => p.value).join("").replace(/\s/g, NBSP);
}

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Whole calendar days from `now`'s date to `d`'s date (local). */
export function daysBetween(d, now = new Date()) {
  return Math.round((dayStart(d) - dayStart(now)) / 86400000);
}

/** "Today", "Tomorrow", "Sunday", "Wed 14 Oct". */
export function day(d, now = new Date()) {
  const n = daysBetween(d, now);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  if (n > -7 && n < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  const opts = { weekday: "short", day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts).replace(/,/g, "");
}

/** "25 min", "1 h 5 min", "2 h", "3 days" — rounded down to the minute. */
export function span(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m}${NBSP}min`;
  if (m < 48 * 60) {
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}${NBSP}h ${r}${NBSP}min` : `${h}${NBSP}h`;
  }
  const d = Math.floor(m / 1440);
  return `${d}${NBSP}days`;
}

/** No-break hyphens in a name. */
export const nb = (text) => String(text ?? "").replace(/-/g, "‑");

/** "−0.2": a true minus sign for negative numbers. */
export const minus = (s) => String(s).replace(/^-/, "−");

/** Parse "2026-10-02T15:30:00Z" (an instant) or "2026-10-02T15:30:00" /
 *  "2026-10-02" (a wall-clock time on the display) into a Date. */
export function parseWhen(iso) {
  const s = String(iso || "");
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return new Date(s);
}
