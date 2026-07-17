// Scene resolution — shared by the dashboard runtime (and kept small/pure for tests).
// Manual hold wins; otherwise the first scene whose schedule is in-window wins
// (list order). Outside all windows with no hold → no scene (baseline config).

/** @param {object|null|undefined} s schedule */
export function inWindow(s, now = new Date()) {
  if (!s?.enabled) return true;
  const dow = (now.getDay() + 6) % 7; // Mon=0 .. Sun=6
  if (s.days?.length && !s.days.includes(dow)) return false;
  if (s.start && s.end) {
    const cur = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = s.start.split(":").map(Number);
    const [eh, em] = s.end.split(":").map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
  }
  return true;
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
