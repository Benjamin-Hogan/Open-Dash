// Image embed — static or periodically refreshed (webcams, radar loops).
import { define } from "./registry.js";
import { el, effectiveSettings } from "./dom.js";

define("image", {
  meta: { label: "Image", description: "Static or refreshing image", category: "embed" },
  schema: {
    fields: [
      { key: "url", label: "Image URL", type: "text", required: true },
      { key: "fit", label: "Fit", type: "select", options: ["cover", "contain"], default: "cover" },
    ],
  },
  async mount(root, widget) {
    const s = effectiveSettings(widget);
    const img = el("img", { class: "embed-image", src: s.url, style: { objectFit: s.fit || "cover" } });
    root.appendChild(img);
    return { img, url: s.url };
  },
  refresh(handle) {
    const u = new URL(handle.url, location.href);
    u.searchParams.set("_r", Date.now().toString());
    handle.img.src = u.toString();
  },
});
