// Local NAS photo gallery — rotates images from PHOTOS_DIR on the server.
import { define } from "./registry.js";
import { el, fetchData, effectiveSettings } from "./dom.js";

define("photos", {
  meta: {
    label: "Local photos",
    description: "Slideshow from a folder on the server (NAS mount)",
    category: "embed",
  },
  schema: {
    fields: [
      { key: "folder", label: "Folder (under PHOTOS_DIR)", type: "text", placeholder: ". or albums/vacation", default: "." },
      { key: "intervalSeconds", label: "Seconds per photo", type: "number", default: 12 },
      { key: "shuffle", label: "Shuffle order", type: "boolean", default: true },
      { key: "fit", label: "Fit", type: "select", options: ["cover", "contain"], default: "cover" },
    ],
  },
  async mount(root, widget) {
    const stage = el("div", { class: "photos-stage" });
    const img = el("img", { class: "photos-img", alt: "" });
    stage.appendChild(img);
    root.appendChild(stage);
    const handle = { stage, img, widget, files: [], index: 0, timer: null };
    await this.refresh(handle, widget);
    return handle;
  },
  async refresh(handle, widget) {
    const s = effectiveSettings(widget || handle.widget);
    try {
      const d = await fetchData("photos", { folder: s.folder || "." });
      handle.files = (d.files || []).map((f) => f.url);
      if (!handle.files.length) {
        handle.img.removeAttribute("src");
        handle.stage.classList.add("empty");
        handle.stage.dataset.empty = "No photos in folder";
        return;
      }
      handle.stage.classList.remove("empty");
      delete handle.stage.dataset.empty;
      if (s.shuffle !== false) shuffle(handle.files);
      handle.index = 0;
      showPhoto(handle, s);
      restartTimer(handle, widget || handle.widget);
    } catch (err) {
      handle.img.removeAttribute("src");
      handle.stage.classList.add("empty");
      handle.stage.dataset.empty = err.message || "Photos unavailable";
    }
  },
  suspend(handle) {
    clearInterval(handle.timer);
    handle.timer = null;
  },
  resume(handle, widget) {
    restartTimer(handle, widget || handle.widget);
  },
  destroy(handle) {
    clearInterval(handle.timer);
  },
});

function showPhoto(handle, settings) {
  if (!handle.files.length) return;
  const url = handle.files[handle.index % handle.files.length];
  handle.img.src = url;
  handle.img.style.objectFit = settings.fit || "cover";
  handle.index = (handle.index + 1) % handle.files.length;
}

function restartTimer(handle, widget) {
  clearInterval(handle.timer);
  const s = effectiveSettings(widget);
  const secs = Math.max(2, Number(s.intervalSeconds) || 12);
  if (handle.files.length < 2) return;
  handle.timer = setInterval(() => showPhoto(handle, s), secs * 1000);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
