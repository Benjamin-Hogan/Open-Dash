// Converting between the stored Schedule shape and something a form can edit.
//
// The schema carries two representations for historical reasons: a legacy
// single window (start/end/days at the top level) and a list of windows that
// are OR'd. The editor only ever wants the list, so this module normalises on
// the way in and picks the narrower representation on the way out — keeping a
// simple schedule looking simple in the saved JSON.
//
// This was previously tangled up in gatherSchedule(), reading the DOM. Pulling
// it out makes the rules testable under plain node.
//
// DOM-free — see core/clone.js.

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const emptyWindow = () => ({ start: null, end: null, days: [] });

/** Stored Schedule -> a draft with exactly one representation. */
export function toDraft(schedule) {
  const s = schedule || {};
  let windows;
  if (Array.isArray(s.windows) && s.windows.length) {
    windows = s.windows.map((w) => ({
      start: w.start || null,
      end: w.end || null,
      days: [...(w.days || [])],
    }));
  } else if (s.start || s.end || (s.days && s.days.length)) {
    windows = [{ start: s.start || null, end: s.end || null, days: [...(s.days || [])] }];
  } else {
    windows = [emptyWindow()];
  }
  return {
    enabled: s.enabled === true,
    timeZone: s.timeZone || "",
    dateFrom: s.dateFrom || "",
    dateTo: s.dateTo || "",
    windows,
  };
}

/** True when the draft says nothing at all — no window, no bounds. */
export function isEmpty(draft) {
  const d = draft || {};
  const anyWindow = (d.windows || []).some((w) => w.start || w.end || (w.days || []).length);
  return !anyWindow && !d.timeZone && !d.dateFrom && !d.dateTo;
}

/**
 * Draft -> stored Schedule, or null when there is nothing to store.
 *
 * A single window with no timezone or date bounds is written in the legacy
 * flat shape, so the common case stays readable in dashboard.config.json
 * rather than growing a `windows` array with one entry in it.
 */
export function fromDraft(draft) {
  const d = draft || {};
  const enabled = d.enabled === true;
  const timeZone = (d.timeZone || "").trim() || null;
  const dateFrom = d.dateFrom || null;
  const dateTo = d.dateTo || null;
  const windows = (d.windows || []).map((w) => ({
    start: w.start || null,
    end: w.end || null,
    days: [...(w.days || [])].sort((a, b) => a - b),
  }));

  if (!enabled && isEmpty({ ...d, windows })) return null;

  const meaningful = windows.filter((w) => w.start || w.end || w.days.length);
  if (meaningful.length <= 1 && !timeZone && !dateFrom && !dateTo) {
    const w = meaningful[0] || emptyWindow();
    return {
      enabled,
      start: w.start, end: w.end, days: w.days,
      windows: [], timeZone: null, dateFrom: null, dateTo: null,
    };
  }
  return {
    enabled,
    start: null, end: null, days: [],
    windows: meaningful.length ? meaningful : [emptyWindow()],
    timeZone, dateFrom, dateTo,
  };
}

/** One-line human summary, for a page tab tooltip or a scene row. */
export function describe(schedule) {
  const d = toDraft(schedule);
  if (!schedule || (!d.enabled && isEmpty(d))) return null;
  const parts = [];
  for (const w of d.windows) {
    if (!w.start && !w.end && !w.days.length) continue;
    const when = w.start && w.end ? `${w.start}–${w.end}` : (w.start || w.end || "all day");
    const days = w.days.length
      ? w.days.slice().sort((a, b) => a - b).map((i) => DAY_LABELS[i]).join(" ")
      : "every day";
    parts.push(`${days} ${when}`);
  }
  if (d.dateFrom || d.dateTo) parts.push(`${d.dateFrom || "…"} → ${d.dateTo || "…"}`);
  if (!parts.length) return d.enabled ? "Always" : null;
  return (d.enabled ? "" : "(off) ") + parts.join(" · ");
}
