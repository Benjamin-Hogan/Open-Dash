// Slideshow — rotates through child "slides", each a mini-widget of any type.
// Demonstrates the first-class suspend/resume lifecycle: only the active slide
// keeps its media live (iframes/videos released on the others), which matters on
// a memory-constrained Pi.
import { define, get } from "./registry.js";
import { el } from "./dom.js";

define("slideshow", {
  meta: { label: "Slideshow", description: "Rotate through multiple widgets", category: "container" },
  schema: {
    fields: [
      { key: "_slidesNote", label: "Slides are configured via the Slideshow section", type: "note" },
    ],
  },
  async mount(root, widget) {
    const cfg = widget.slideshow || {};
    const slides = cfg.slides || [];
    const stage = el("div", { class: "slideshow" });
    root.appendChild(stage);
    const mounted = [];
    for (const slide of slides) {
      const plugin = get(slide.type);
      const pane = el("div", { class: "slide" });
      stage.appendChild(pane);
      let handle = null;
      if (plugin) {
        const slideWidget = { ...slide, settings: slide.settings || {} };
        try { handle = await plugin.mount(pane, slideWidget); } catch {}
      } else {
        pane.appendChild(el("div", { class: "widget-error" }, `Unknown slide type: ${slide.type}`));
      }
      mounted.push({ pane, plugin, handle });
    }
    const handle = {
      stage, mounted, index: 0,
      durationMs: Math.max(2, cfg.durationSeconds || 30) * 1000,
    };
    show(handle, 0);
    if (mounted.length > 1) {
      handle.timer = setInterval(() => show(handle, (handle.index + 1) % mounted.length), handle.durationMs);
    }
    return handle;
  },
  suspend(handle) {
    clearInterval(handle.timer);
    const cur = handle.mounted[handle.index];
    cur?.plugin?.suspend?.(cur.handle);
  },
  resume(handle) {
    const cur = handle.mounted[handle.index];
    cur?.plugin?.resume?.(cur.handle);
    if (handle.mounted.length > 1) {
      handle.timer = setInterval(() => show(handle, (handle.index + 1) % handle.mounted.length), handle.durationMs);
    }
  },
});

function show(handle, next) {
  handle.mounted.forEach((m, i) => {
    const active = i === next;
    m.pane.classList.toggle("active", active);
    if (active) m.plugin?.resume?.(m.handle);
    else m.plugin?.suspend?.(m.handle);
  });
  handle.index = next;
}
