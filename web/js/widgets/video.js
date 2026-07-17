// Video embed — looping local/remote MP4 etc. By default suspend releases media
// (slideshow / widget schedule) so a Pi only keeps the active slide loaded.
// Page rotation passes { releaseMedia: false } to pause in place and resume
// without restarting from t=0.
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
    return { video, url: s.url, time: 0 };
  },
  suspend(handle, opts = {}) {
    const video = handle.video;
    if (!video) return;
    try { handle.time = video.currentTime || 0; } catch { /* ignore */ }
    video.pause();
    if (opts.releaseMedia === false) return;
    video.removeAttribute("src");
    video.load();
  },
  resume(handle, opts = {}) {
    const video = handle.video;
    if (!video) return;
    if (opts.releaseMedia === false && video.getAttribute("src")) {
      video.play().catch(() => {});
      return;
    }
    video.src = handle.url;
    const seekAndPlay = () => {
      const t = handle.time;
      if (t > 0 && Number.isFinite(t)) {
        try { video.currentTime = t; } catch { /* ignore */ }
      }
      video.play().catch(() => {});
    };
    if (video.readyState >= 1) seekAndPlay();
    else video.addEventListener("loadedmetadata", seekAndPlay, { once: true });
  },
});
