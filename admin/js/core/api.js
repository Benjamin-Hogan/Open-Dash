// Every network call the admin makes, in one place.
//
// Two things this centralises that were previously scattered inline:
//   · a 409 carries the server's current version, so callers can merge instead
//     of reloading and discarding;
//   · a 422 carries Pydantic's full `detail` array, each entry with a `loc`
//     tuple the form engine turns into a field path. The old code kept
//     detail[0].msg and threw the rest away.

export class ApiError extends Error {
  constructor(message, { status, detail, currentVersion } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.currentVersion = currentVersion;
  }
}

/** Pydantic `loc` is ["body", "pages", 0, "widgets", 1, "grid", "w"]. Drop the
 *  "body" marker and join the rest into the dotted path the form engine uses. */
export function locToPath(loc) {
  const parts = (loc || []).filter((p) => p !== "body");
  return parts.join(".");
}

/** Normalise a 422 body into [{ path, message }]. */
export function validationErrors(detail) {
  if (!Array.isArray(detail)) return [];
  return detail.map((d) => ({ path: locToPath(d.loc), message: d.msg || String(d) }));
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(`Network error: ${e.message}`, { status: 0 });
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (res.ok) return data;

  if (res.status === 409) {
    throw new ApiError("Config changed on the server", {
      status: 409,
      currentVersion: data?.detail?.currentVersion,
      detail: data?.detail,
    });
  }
  if (res.status === 422) {
    const errs = validationErrors(data?.detail);
    throw new ApiError(errs[0]?.message || "Validation failed", { status: 422, detail: data?.detail });
  }
  const msg = typeof data?.detail === "string" ? data.detail : `${method} ${url} failed (${res.status})`;
  throw new ApiError(msg, { status: res.status, detail: data?.detail });
}

export const get = (url) => request("GET", url);
export const post = (url, body) => request("POST", url, body);
export const put = (url, body) => request("PUT", url, body);
export const del = (url) => request("DELETE", url);

// ---- named endpoints --------------------------------------------------------

export const loadConfig = () => get("/api/config");
export const saveConfig = (cfg) => put("/api/config", cfg);
/** Dry run against the real validator — no version gate, no write. */
export const validateConfig = (cfg) => post("/api/config/validate", cfg);
export const loadMeta = () => get("/api/meta");

export const loadSecrets = () => get("/api/secrets");
export const saveSecrets = (values) => put("/api/secrets", { values });

export const loadBackups = () => get("/api/backups");
export const restoreBackup = (name) => post("/api/backups/restore", { name });

export const loadDevices = () => get("/api/devices");
export const saveDevicePrefs = (id, prefs) => put(`/api/devices/${encodeURIComponent(id)}/prefs`, prefs);

export const loadAlerts = () => get("/api/alerts");
export const dismissAlert = (id) => del(`/api/alerts/${encodeURIComponent(id)}`);
export const clearAlerts = () => post("/api/alerts/clear-all");
export const testAlert = () => post("/api/alerts/test");

export const clearCache = () => post("/api/cache/clear");
export const forceRefresh = () => post("/api/refresh");
export const systemUpdate = () => post("/api/system/update");

export const searchStocks = (q) => get("/api/data/stocks/search?q=" + encodeURIComponent(q));
