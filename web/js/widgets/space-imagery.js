// Space-weather imagery — shows a server-built animated GIF for the chosen source
// (aurora, LASCO coronagraphs, GOES/SUVI EUV channels, Enlil solar wind). The
// backend (server/gifs.py) fetches NOAA SWPC frames and assembles the GIF; this
// widget just displays /api/gif/<slug> and periodically re-fetches the latest.
//
// Slugs here MUST match server/gifs.py SOURCES keys.
import { define } from "./registry.js";
import { el, effectiveSettings } from "./dom.js";

const SOURCES = [
  { value: "aurora-north", label: "Aurora — North (forecast)" },
  { value: "aurora-south", label: "Aurora — South (forecast)" },
  { value: "lasco-c2", label: "LASCO C2 (coronagraph)" },
  { value: "lasco-c3", label: "LASCO C3 (wide coronagraph)" },
  { value: "suvi-094", label: "SUVI 094 Å (flares)" },
  { value: "suvi-131", label: "SUVI 131 Å (flares)" },
  { value: "suvi-171", label: "SUVI 171 Å (corona)" },
  { value: "suvi-195", label: "SUVI 195 Å (corona)" },
  { value: "suvi-284", label: "SUVI 284 Å (active regions)" },
  { value: "suvi-304", label: "SUVI 304 Å (chromosphere)" },
  { value: "sunspots", label: "Sunspots (HMI continuum)" },
  { value: "enlil", label: "Solar wind (WSA-Enlil)" },
];
const LABELS = Object.fromEntries(SOURCES.map((s) => [s.value, s.label]));
const DEFAULT = "aurora-north";
const DEFAULT_REFRESH_SEC = 600;

define("space-imagery", {
  meta: { label: "Space imagery", description: "Aurora / LASCO / SUVI loops", category: "embed" },
  schema: {
    fields: [
      { key: "source", label: "Source", type: "select", options: SOURCES, default: DEFAULT },
      { key: "gifRefreshSeconds", label: "Re-fetch GIF every N seconds", type: "number", default: DEFAULT_REFRESH_SEC },
      { key: "showCaption", label: "Show source caption", type: "boolean", default: true },
    ],
  },
  async mount(root, widget) {
    const wrap = el("div", { class: "spaceimg" });
    const img = el("img", { class: "spaceimg-img", alt: "" });
    const cap = el("div", { class: "spaceimg-cap" });
    wrap.append(img, cap);
    root.appendChild(wrap);
    const handle = { wrap, img, cap, widget };
    img.addEventListener("load", () => {
      const s = effectiveSettings(handle.widget);
      handle.cap.textContent = s.showCaption === false ? "" : (LABELS[handle.slug] || "");
    });
    img.addEventListener("error", () => {
      const s = effectiveSettings(handle.widget);
      handle.cap.textContent = s.showCaption === false
        ? ""
        : `${LABELS[handle.slug] || handle.slug} — building…`;
    });
    load(handle);
    armTimer(handle);
    return handle;
  },
  refresh(handle) { load(handle); },
  suspend(handle) {
    // free the decoder while off-screen (GIFs keep animating otherwise)
    handle.suspendedSrc = handle.img.src;
    handle.img.removeAttribute("src");
  },
  resume(handle) { if (handle.suspendedSrc) handle.img.src = handle.suspendedSrc; },
  destroy(handle) { clearInterval(handle.timer); },
});

function refreshMs(widget) {
  const s = effectiveSettings(widget);
  const sec = Number(s.gifRefreshSeconds) || DEFAULT_REFRESH_SEC;
  return Math.max(30, sec) * 1000;
}

function armTimer(handle) {
  clearInterval(handle.timer);
  handle.timer = setInterval(() => load(handle), refreshMs(handle.widget));
}

function load(handle) {
  const s = effectiveSettings(handle.widget);
  const slug = LABELS[s.source] ? s.source : DEFAULT;
  handle.slug = slug;
  handle.cap.textContent = s.showCaption === false ? "" : `${LABELS[slug]} — building…`;
  // cache-bust so a rebuilt GIF is picked up; the endpoint caches for its TTL
  handle.img.src = `/api/gif/${slug}?_r=${Date.now()}`;
}
