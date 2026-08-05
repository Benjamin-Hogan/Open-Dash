// Live page conditions: show a page while the printer is running, a weather
// alert is active, a stream is live, or an event is coming up.
//
// The rules — which fields belong to which trigger type, what the sensible
// default priority is, and how values are clamped — used to live inside a
// redraw closure and a gatherCondition() that read the DOM. Here they are
// plain data and pure functions, so they can be tested and the form can be
// generated from them.
//
// DOM-free — see core/clone.js.

export const TYPES = [
  { value: "octoprint", label: "OctoPrint (printer state)" },
  { value: "weather-alert", label: "Weather alert (NWS)" },
  { value: "youtube-live", label: "YouTube live" },
  { value: "calendar-soon", label: "Calendar event soon" },
];

export const MODES = [
  { value: "soft-join", label: "Soft-join (rotate with other pages)" },
  { value: "force-override", label: "Force-override (jump and hold)" },
];

export const PRINTER_STATES = [
  { value: "printing", label: "printing" },
  { value: "paused", label: "paused" },
  { value: "error", label: "error" },
];

export const SEVERITIES = [
  { value: "", label: "Any" },
  { value: "info", label: "Info+" },
  { value: "warning", label: "Warning+" },
  { value: "danger", label: "Danger only" },
];

/** Which widget type, if any, a trigger reads its state from. */
export const SOURCE_TYPE = {
  octoprint: "octoprint",
  "youtube-live": "youtube-live",
  "calendar-soon": "ical",
};

/**
 * A sensible starting priority per trigger, so competing force-overrides
 * resolve the way most people would expect: a weather emergency outranks a
 * printer, which outranks a stream, which outranks a calendar reminder.
 */
export function defaultPriority(type, matchStates) {
  if (type === "weather-alert") return 90;
  if (type === "youtube-live") return 40;
  if (type === "calendar-soon") return 30;
  if (type === "octoprint") return (matchStates || []).includes("error") ? 80 : 50;
  return 50;
}

/** Stored PageCondition -> a draft with every field present. */
export function toDraft(condition) {
  const c = condition || {};
  const type = c.type || "octoprint";
  return {
    enabled: c.enabled === true,
    type,
    mode: c.mode || "soft-join",
    priority: c.priority ?? defaultPriority(type, c.matchStates),
    sourceWidgetId: c.sourceWidgetId || "",
    matchStates: c.matchStates?.length ? [...c.matchStates] : ["printing"],
    minSeverity: c.minSeverity || "",
    leadMinutes: c.leadMinutes ?? 30,
    pollSeconds: c.pollSeconds ?? null,
  };
}

const clamp = (n, lo, hi, fallback) => {
  // Number("") is 0, not NaN — so a cleared field would silently become the
  // lowest legal value (priority 0 = never wins) instead of falling back.
  if (n === "" || n === null || n === undefined) return fallback;
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
};

/**
 * Draft -> stored PageCondition, or null when disabled.
 *
 * Only the fields that belong to the chosen trigger are written, so switching
 * from OctoPrint to a weather alert doesn't leave a stale sourceWidgetId
 * behind for the evaluator to trip over.
 */
export function fromDraft(draft) {
  const d = draft || {};
  if (d.enabled !== true) return null;

  const type = d.type || "octoprint";
  const out = {
    enabled: true,
    type,
    mode: d.mode || "soft-join",
    priority: clamp(d.priority, 0, 100, defaultPriority(type, d.matchStates)),
    pollSeconds: d.pollSeconds == null || d.pollSeconds === ""
      ? null
      : clamp(d.pollSeconds, 2, 300, null),
  };

  if (type === "octoprint") {
    out.sourceWidgetId = d.sourceWidgetId || null;
    out.matchStates = d.matchStates?.length ? [...d.matchStates] : ["printing"];
  } else if (type === "weather-alert") {
    out.minSeverity = d.minSeverity || null;
  } else if (type === "youtube-live") {
    out.sourceWidgetId = d.sourceWidgetId || null;
  } else if (type === "calendar-soon") {
    out.sourceWidgetId = d.sourceWidgetId || null;
    out.leadMinutes = clamp(d.leadMinutes, 1, 10080, 30);
  }
  return out;
}

/** One-line human summary for a page tab tooltip. */
export function describe(condition) {
  if (!condition?.enabled) return null;
  const label = TYPES.find((t) => t.value === condition.type)?.label || condition.type;
  const bits = [label];
  if (condition.type === "octoprint" && condition.matchStates?.length) {
    bits.push(condition.matchStates.join("/"));
  }
  if (condition.type === "weather-alert" && condition.minSeverity) {
    bits.push(`${condition.minSeverity}+`);
  }
  if (condition.type === "calendar-soon") bits.push(`${condition.leadMinutes ?? 30} min ahead`);
  if (condition.mode === "force-override") bits.push(`override p${condition.priority}`);
  return bits.join(" · ");
}
