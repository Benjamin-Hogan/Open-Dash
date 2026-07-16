// RSS / Atom reader — fetched + parsed server-side (provider "rss").
// Cycle mode (default): one story at a time as a big image card, auto-advancing.
// List mode: all items as compact cards.
import { define } from "./registry.js";
import { el, fetchData, effectiveSettings } from "./dom.js";

define("rss", {
  meta: { label: "RSS feed", description: "Cycling stories with images", category: "data" },
  schema: {
    fields: [
      { key: "url", label: "Feed URL (RSS or Atom)", type: "text", required: true, placeholder: "https://…/rss.xml" },
      { key: "count", label: "Stories to pull", type: "number", default: 10 },
      { key: "cycle", label: "Cycle one story at a time", type: "boolean", default: true },
      { key: "cycleSeconds", label: "Seconds per story (cycle mode)", type: "number", default: 8 },
      { key: "showImages", label: "Show images", type: "boolean", default: true },
      { key: "showDescription", label: "Show descriptions", type: "boolean", default: true },
      { key: "showTitle", label: "Show feed name", type: "boolean", default: true },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "rss" });
    root.appendChild(body);
    const handle = { body, widget };
    await this.refresh(handle);
    return handle;
  },
  async refresh(handle) {
    stopCycle(handle);
    const s = effectiveSettings(handle.widget);
    handle.s = s;
    if (!s.url) { handle.body.replaceChildren(el("div", { class: "widget-empty" }, "Set a feed URL")); return; }
    try {
      const d = await fetchData("rss", { url: s.url, count: s.count || 10 });
      handle.feed = d;
      handle.items = d.items || [];
      handle.idx = 0;
      render(handle);
    } catch {
      handle.body.replaceChildren(el("div", { class: "widget-error" }, "feed unavailable"));
    }
  },
  suspend(handle) { stopCycle(handle); },
  resume(handle) { if (handle.s?.cycle !== false) startCycle(handle); },
  destroy(handle) { stopCycle(handle); },
});

function render(handle) {
  const { s, items } = handle;
  if (!items.length) { handle.body.replaceChildren(el("div", { class: "widget-empty" }, "No items")); return; }
  if (s.cycle !== false) { renderSolo(handle); startCycle(handle); }
  else { stopCycle(handle); renderList(handle); }
}

function startCycle(handle) {
  stopCycle(handle);
  if (!handle.items || handle.items.length < 2) return;
  const secs = Math.max(3, Number(handle.s.cycleSeconds) || 8);
  handle.cycleTimer = setInterval(() => {
    handle.idx = (handle.idx + 1) % handle.items.length;
    renderSolo(handle);
  }, secs * 1000);
}
function stopCycle(handle) { clearInterval(handle.cycleTimer); handle.cycleTimer = null; }

// ---- one-story view (cycle mode) --------------------------------------------
function renderSolo(handle) {
  const { s, feed, items, idx } = handle;
  const it = items[idx];
  const meta = [s.showTitle !== false ? feed.feedTitle : null, it.author, relTime(it.published)]
    .filter(Boolean).join(" · ");
  const card = el("article", { class: "rss-solo" }, [
    (s.showImages !== false && it.image)
      ? el("div", { class: "rss-solo-img", style: { backgroundImage: `url("${cssUrl(it.image)}")` } }) : null,
    el("div", { class: "rss-solo-text" }, [
      el("div", { class: "rss-solo-title" }, it.title || "(untitled)"),
      (s.showDescription !== false && it.description)
        ? el("div", { class: "rss-solo-desc" }, it.description) : null,
      el("div", { class: "rss-solo-foot" }, [
        el("span", { class: "rss-meta" }, meta),
        dots(items.length, idx),
      ]),
    ]),
  ]);
  handle.body.replaceChildren(card);
}

function dots(n, active) {
  const wrap = el("div", { class: "rss-dots" });
  for (let i = 0; i < Math.min(n, 12); i++) {
    wrap.appendChild(el("span", { class: "rss-dot" + (i === active ? " on" : "") }));
  }
  return wrap;
}

// ---- list view (cycle off) --------------------------------------------------
function renderList(handle) {
  const { s, feed, items } = handle;
  const children = [];
  if (s.showTitle !== false && feed.feedTitle) {
    children.push(el("div", { class: "rss-head" }, [
      feed.feedImage ? el("img", { class: "rss-favicon", src: feed.feedImage, alt: "" }) : null,
      el("span", {}, feed.feedTitle),
    ]));
  }
  for (const it of items) {
    const media = (s.showImages !== false && it.image)
      ? el("img", { class: "rss-thumb", src: it.image, alt: "", loading: "lazy" }) : null;
    const meta = [it.author, relTime(it.published)].filter(Boolean).join(" · ");
    children.push(el("article", { class: "rss-item" + (media ? "" : " no-img") }, [
      media,
      el("div", { class: "rss-body" }, [
        el("div", { class: "rss-title" }, it.title || "(untitled)"),
        (s.showDescription !== false && it.description) ? el("div", { class: "rss-desc" }, it.description) : null,
        meta ? el("div", { class: "rss-meta" }, meta) : null,
      ]),
    ]));
  }
  handle.body.replaceChildren(el("div", { class: "rss-list" }, children));
}

function cssUrl(u) { return String(u).replace(/"/g, "%22"); }

function relTime(s) {
  if (!s) return "";
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) return "";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}
