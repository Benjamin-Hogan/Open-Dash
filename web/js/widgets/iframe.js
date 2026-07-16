// Iframe embed — windy, tradingview, NASA Eyes, FlightRadar, etc.
// Sandbox is ON by default; disableSandbox is an explicit per-widget opt-out.
import { define } from "./registry.js";
import { el, effectiveSettings } from "./dom.js";

define("iframe", {
  meta: { label: "Iframe embed", description: "Embed any website", category: "embed" },
  schema: {
    fields: [
      { key: "url", label: "URL", type: "url-presets", required: true, placeholder: "https://…",
        presets: [
          { label: "Flight radar (ADS-B Exchange)", url: "https://globe.adsbexchange.com/" },
          { label: "Weather radar (Windy)", url: "https://embed.windy.com/embed2.html?lat=33.45&lon=-112.07&zoom=6&level=surface&overlay=radar" },
          { label: "Wind / earth (nullschool)", url: "https://earth.nullschool.net/" },
        ] },
      { key: "disableSandbox", label: "Disable sandbox (allow third-party JS)", type: "boolean", default: false, group: "embed" },
      { key: "referrerPolicy", label: "Referrer policy", type: "text", group: "embed" },
      { key: "allow", label: "Permissions (allow=)", type: "text", group: "embed" },
    ],
  },
  async mount(root, widget) {
    const s = effectiveSettings(widget);
    const frame = el("iframe", {
      class: "embed-frame",
      src: s.url || "about:blank",
      loading: "lazy",
      referrerpolicy: widget.embed?.referrerPolicy || s.referrerPolicy,
      allow: widget.embed?.allow || s.allow,
    });
    // sandbox unless explicitly disabled
    const disable = widget.embed?.disableSandbox ?? s.disableSandbox;
    if (!disable) {
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms");
    }
    root.appendChild(frame);
    return { frame, url: s.url };
  },
  refresh(handle) {
    // cache-bust the embed
    const u = new URL(handle.url, location.href);
    u.searchParams.set("_r", Date.now().toString());
    handle.frame.src = u.toString();
  },
  suspend(handle) {
    handle.frame.dataset.src = handle.frame.src;
    handle.frame.src = "about:blank";
  },
  resume(handle) {
    if (handle.frame.dataset.src) handle.frame.src = handle.frame.dataset.src;
  },
});
