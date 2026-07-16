// Video embed — looping local/remote MP4 etc. Media is released on suspend so a
// memory-constrained Pi only keeps the active slide loaded.
import { define } from "./registry.js";
import { el, effectiveSettings } from "./dom.js";

define("video", {
  meta: { label: "Video", description: "Looping video", category: "embed" },
  schema: {
    fields: [
      { key: "url", label: "Video URL", type: "text", required: true },
      { key: "muted", label: "Muted", type: "boolean", default: true },
      { key: "loop", label: "Loop", type: "boolean", default: true },
    ],
  },
  async mount(root, widget) {
    const s = effectiveSettings(widget);
    const video = el("video", {
      class: "embed-video",
      src: s.url,
      autoplay: true,
      muted: s.muted !== false,
      loop: s.loop !== false,
      playsinline: true,
    });
    video.muted = s.muted !== false; // attribute alone is unreliable for autoplay
    root.appendChild(video);
    return { video, url: s.url };
  },
  suspend(handle) {
    handle.video.pause();
    handle.video.removeAttribute("src");
    handle.video.load();
  },
  resume(handle) {
    handle.video.src = handle.url;
    handle.video.play().catch(() => {});
  },
});
