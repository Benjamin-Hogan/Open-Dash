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

// Apply variant overrides over a widget's settings (shallow merge), so heavy
// embeds don't repeat full URLs N times in config.
export function effectiveSettings(widget) {
  const base = { ...(widget.settings || {}) };
  const active = (widget.variants || []).find((v) => v.active) || (widget.variants || [])[0];
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
