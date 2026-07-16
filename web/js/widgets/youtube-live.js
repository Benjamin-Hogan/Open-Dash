// YouTube widget — plays a specific video/playlist (no key needed) OR a channel's
// current live stream (needs YOUTUBE_API_KEY + backend lookup).
//
// Paste any YouTube URL or an 11-char video id in "url" and it just embeds and
// plays it. For an always-on "whatever this channel is streaming live right now",
// set "channelId" instead — the backend resolves the live videoId (quota-aware)
// and we re-check liveness periodically so a dead stream recovers on its own.
import { define } from "./registry.js";
import { el, effectiveSettings, fetchData } from "./dom.js";

const LIVE_RECHECK_MS = 120000; // 2 min — backend re-verify is cheap (1 quota unit)

define("youtube-live", {
  meta: { label: "YouTube", description: "A video, playlist, or channel live stream", category: "embed" },
  schema: {
    fields: [
      { key: "url", label: "YouTube URL or video ID (video / playlist / live link)", type: "text", placeholder: "https://youtu.be/… or https://youtube.com/watch?v=…" },
      { key: "channelId", label: "…or Channel ID for its current LIVE stream (UC…)", type: "text", placeholder: "UCxxxxxxxxxxxxxxxxxxxxxx" },
      { key: "mute", label: "Muted (required for autoplay)", type: "boolean", default: true },
      { key: "autoplay", label: "Autoplay", type: "boolean", default: true },
    ],
  },
  async mount(root, widget) {
    const wrap = el("div", { class: "yt-wrap" });
    root.appendChild(wrap);
    const handle = { wrap, root, widget, alive: true };
    await load(handle);
    return handle;
  },
  async refresh(handle) {
    // for plain video embeds there's nothing to refetch; live mode self-rechecks
  },
  suspend(handle) { command(handle, "pauseVideo"); },
  resume(handle) { command(handle, "playVideo"); },
  destroy(handle) {
    handle.alive = false;
    clearInterval(handle.recheck);
  },
});

async function load(handle) {
  const s = effectiveSettings(handle.widget);
  const params = ytParams(s);

  // 1) explicit URL / id → embed directly (no key, no backend)
  if (s.url && s.url.trim()) {
    const src = embedFromUrl(s.url.trim());
    if (!src) {
      handle.wrap.replaceChildren(el("div", { class: "widget-error" }, "Couldn't read that YouTube link"));
      return;
    }
    embed(handle, src + params);
    return;
  }

  // 2) channel live mode → resolve via backend
  const channelId = (s.channelId || "").trim();
  if (!channelId) {
    handle.wrap.replaceChildren(el("div", { class: "widget-empty" }, "Paste a YouTube URL, or set a Channel ID for live"));
    return;
  }
  let data;
  try {
    data = await fetchData("youtube-live", { channelId });
  } catch {
    handle.wrap.replaceChildren(el("div", { class: "widget-error" }, "YouTube lookup failed"));
    return;
  }
  if (data.needsKey) {
    handle.wrap.replaceChildren(el("div", { class: "widget-error" }, `Set ${data.env} (API keys panel) for live channel mode`));
    return;
  }
  if (!data.videoId) {
    handle.wrap.replaceChildren(el("div", { class: "widget-empty" }, "Channel isn't live right now"));
    scheduleRecheck(handle, channelId);
    return;
  }
  handle.liveVideoId = data.videoId;
  embed(handle, `https://www.youtube.com/embed/${data.videoId}?` + params.slice(1));
  scheduleRecheck(handle, channelId);
}

// Re-verify the live stream periodically using the backend's cheap check; if the
// videoId changed or the stream ended, re-render. Reliable, unlike a postMessage
// handshake that hides working embeds when it just doesn't hear back.
function scheduleRecheck(handle, channelId) {
  clearInterval(handle.recheck);
  handle.recheck = setInterval(async () => {
    if (!handle.alive) return;
    try {
      const d = await fetchData("youtube-live", { channelId });
      if (d.videoId !== handle.liveVideoId) { handle.liveVideoId = d.videoId; load(handle); }
    } catch { /* keep showing what we have */ }
  }, LIVE_RECHECK_MS);
}

function ytParams(s) {
  const mute = s.mute !== false ? 1 : 0;
  const autoplay = s.autoplay !== false ? 1 : 0;
  return `?autoplay=${autoplay}&mute=${mute}&playsinline=1&rel=0&enablejsapi=1`;
}

function embed(handle, src) {
  const frame = el("iframe", {
    class: "yt-frame",
    src,
    allow: "autoplay; encrypted-media; picture-in-picture",
    frameborder: "0",
    allowfullscreen: "",
  });
  handle.frame = frame;
  handle.wrap.replaceChildren(frame);
}

// Turn any YouTube link (or bare id) into an /embed/ URL (without query string).
function embedFromUrl(input) {
  // bare 11-char video id
  if (/^[\w-]{11}$/.test(input)) return `https://www.youtube.com/embed/${input}`;
  let u;
  try { u = new URL(input.includes("://") ? input : "https://" + input); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);

  if (host === "youtu.be" && parts[0]) return `https://www.youtube.com/embed/${parts[0]}`;
  if (u.searchParams.get("v")) return `https://www.youtube.com/embed/${u.searchParams.get("v")}`;
  const list = u.searchParams.get("list");
  if (list) return `https://www.youtube.com/embed/videoseries?list=${list}`;
  // /live/ID , /embed/ID , /shorts/ID
  const idx = parts.findIndex((p) => ["live", "embed", "shorts", "v"].includes(p));
  if (idx >= 0 && parts[idx + 1]) return `https://www.youtube.com/embed/${parts[idx + 1]}`;
  return null;
}

function command(handle, func) {
  handle.frame?.contentWindow?.postMessage(
    JSON.stringify({ event: "command", func, args: [] }), "*"
  );
}
