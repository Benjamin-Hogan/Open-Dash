// Scene resolution — shared by the dashboard runtime (and kept small/pure for tests).
// Manual hold wins; otherwise the first scene whose schedule is in-window wins
// (list order). Outside all windows with no hold → no scene (baseline config).

const _DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Normalize schedule into a list of windows (legacy start/end/days → one window). */
export function scheduleWindows(s) {
  if (!s) return [];
  if (Array.isArray(s.windows) && s.windows.length) return s.windows;
  if (s.start || s.end || (s.days && s.days.length)) {
    return [{ start: s.start || null, end: s.end || null, days: s.days || [] }];
  }
  return [{}]; // enabled with no bounds → always in
}

/** Local (or timeZone) calendar parts for schedule matching. */
export function scheduleParts(now = new Date(), timeZone = null) {
  if (!timeZone) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return {
      dow: (now.getDay() + 6) % 7,
      minutes: now.getHours() * 60 + now.getMinutes(),
      ymd: `${y}-${m}-${d}`,
    };
  }
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t) => dateParts.find((p) => p.type === t)?.value;
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(timeParts.find((p) => p.type === "hour")?.value || 0) % 24;
  const minute = Number(timeParts.find((p) => p.type === "minute")?.value || 0);
  return {
    dow: _DOW[wd] ?? 0,
    minutes: hour * 60 + minute,
    ymd,
  };
}

function matchWindow(w, parts) {
  if (w?.days?.length && !w.days.includes(parts.dow)) return false;
  if (w?.start && w?.end) {
    const [sh, sm] = w.start.split(":").map(Number);
    const [eh, em] = w.end.split(":").map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    const cur = parts.minutes;
    return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
  }
  return true;
}

/** @param {object|null|undefined} s schedule */
export function inWindow(s, now = new Date()) {
  if (!s?.enabled) return true;
  let parts;
  try {
    parts = scheduleParts(now, s.timeZone || null);
  } catch {
    // Bad IANA zone → fall back to device local rather than hide forever.
    parts = scheduleParts(now, null);
  }
  if (s.dateFrom && parts.ymd < s.dateFrom) return false;
  if (s.dateTo && parts.ymd > s.dateTo) return false;
  return scheduleWindows(s).some((w) => matchWindow(w, parts));
}

/**
 * @param {object} cfg dashboard config
 * @param {Date} [now]
 * @returns {object|null} scene or null
 */
export function resolveActiveScene(cfg, now = new Date()) {
  const scenes = cfg?.scenes || [];
  const byId = new Map(scenes.map((s) => [s.id, s]));

  if (cfg?.sceneManualHold) {
    return (cfg.activeSceneId && byId.get(cfg.activeSceneId)) || null;
  }

  for (const s of scenes) {
    if (s.schedule?.enabled && inWindow(s.schedule, now)) return s;
  }
  return null;
}

/** Merge scene theme overlay onto settings (shallow copy). */
export function settingsWithScene(settings, scene) {
  const base = { ...(settings || {}) };
  const theme = { ...(base.theme || {}) };
  if (scene?.theme?.mode) theme.mode = scene.theme.mode;
  if (scene?.theme?.accent) theme.accent = scene.theme.accent;
  base.theme = theme;
  return base;
}

/** Merge scene rotation overlay onto rotation (shallow copy). */
export function rotationWithScene(rotation, scene) {
  const base = { ...(rotation || {}) };
  if (!scene?.rotation) return base;
  if (scene.rotation.enabled != null) base.enabled = scene.rotation.enabled;
  if (scene.rotation.defaultDurationSeconds != null) {
    base.defaultDurationSeconds = scene.rotation.defaultDurationSeconds;
  }
  return base;
}
