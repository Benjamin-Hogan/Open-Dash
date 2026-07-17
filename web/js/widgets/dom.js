// Tiny DOM helpers shared by widget plugins (no framework, no build).

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// Scene-driven variant label (set by app.js while a scene is active). Widgets
// that define a matching variant.label use it; others fall back to prior rules.
let sceneVariantLabel = null;

export function setSceneVariantLabel(label) {
  sceneVariantLabel = label && String(label).trim() ? String(label).trim() : null;
}

export function getSceneVariantLabel() {
  return sceneVariantLabel;
}

// Apply variant overrides over a widget's settings (shallow merge), so heavy
// embeds don't repeat full URLs N times in config. Scene label wins when it
// matches a variant; otherwise the first variant is the default (if any).
export function effectiveSettings(widget) {
  const base = { ...(widget.settings || {}) };
  const variants = widget.variants || [];
  let active = null;
  if (sceneVariantLabel) {
    active = variants.find((v) => v.label === sceneVariantLabel) || null;
  }
  if (!active) active = variants[0] || null;
  return active ? { ...base, ...(active.overrides || {}) } : base;
}

export function fmtNum(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

// Fetch a data provider's JSON: /api/data/<provider>?<params>
export async function fetchData(provider, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/data/${provider}${qs ? "?" + qs : ""}`);
  if (!res.ok) throw new Error(`${provider}: ${res.status}`);
  return res.json();
}
