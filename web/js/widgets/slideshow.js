// Slideshow — rotates through child "slides", each a mini-widget of any type.
// Demonstrates the first-class suspend/resume lifecycle: only the active slide
// keeps its media live (iframes/videos released on the others), which matters on
// a memory-constrained Pi.
// Slides are edited in the admin widget form (widget.slideshow), not page rotation.
import { define, get } from "./registry.js";
import { el } from "./dom.js";

define("slideshow", {
  meta: { label: "Slideshow", description: "Rotate through multiple widgets", category: "container" },
  schema: {
    fields: [
      { key: "_slidesNote", label: "Add and configure slides below (after Save fields like duration).", type: "note" },
    ],
  },
  async mount(root, widget) {
    const cfg = widget.slideshow || {};
    const slides = cfg.slides || [];
    const stage = el("div", { class: "slideshow" });
    root.appendChild(stage);
    if (!slides.length) {
      stage.appendChild(el("div", { class: "widget-empty" }, "No slides configured"));
      return { stage, mounted: [], index: 0, durationMs: 30000, timer: null };
    }
    const mounted = [];
    for (const slide of slides) {
      const plugin = get(slide.type);
      const pane = el("div", { class: "slide" });
      stage.appendChild(pane);
      let handle = null;
      if (plugin) {
        const slideWidget = { ...slide, settings: slide.settings || {} };
        try {
          handle = await plugin.mount(pane, slideWidget);
        } catch (err) {
          pane.appendChild(el("div", { class: "widget-error" }, `Failed: ${err.message || err}`));
        }
      } else {
        pane.appendChild(el("div", { class: "widget-error" }, `Unknown slide type: ${slide.type}`));
      }
      mounted.push({ pane, plugin, handle });
    }
    const rotating = cfg.enabled !== false && mounted.length > 1;
    const handle = {
      stage, mounted, index: 0,
      durationMs: Math.max(2, cfg.durationSeconds || 30) * 1000,
      timer: null,
      rotating,
    };
    show(handle, 0);
    if (rotating) {
      handle.timer = setInterval(() => show(handle, (handle.index + 1) % mounted.length), handle.durationMs);
    }
    return handle;
  },
  suspend(handle) {
    clearInterval(handle.timer);
    handle.timer = null;
    const cur = handle.mounted[handle.index];
    cur?.plugin?.suspend?.(cur.handle);
  },
  resume(handle) {
    const cur = handle.mounted[handle.index];
    cur?.plugin?.resume?.(cur.handle);
    if (handle.rotating && handle.mounted.length > 1 && !handle.timer) {
      handle.timer = setInterval(() => show(handle, (handle.index + 1) % handle.mounted.length), handle.durationMs);
    }
  },
  destroy(handle) {
    clearInterval(handle.timer);
    handle.timer = null;
    for (const m of handle.mounted || []) {
      m.plugin?.suspend?.(m.handle);
      m.plugin?.destroy?.(m.handle);
    }
    handle.mounted = [];
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
