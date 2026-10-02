// On this day — Wikipedia's selected anniversaries for today, one at a time:
// the year, how long ago, the sentence at reading size, and the article's
// picture when it has one. Changes every few minutes (a thin line shows the
// time left), never every few seconds: it's in someone's peripheral vision
// all day. Data: /api/data/on-this-day for the display's own date.
import { define } from "./registry.js";
import { el, fetchData, loadInto } from "./dom.js";

define("on-this-day", {
  meta: {
    label: "On this day",
    description: "Anniversaries from Wikipedia, one at a time",
    category: "data",
    showTitle: false,
    defaultRefreshSeconds: 3600,
  },
  schema: {
    fields: [
      { key: "minutes", label: "Show each for (minutes)", type: "number", default: 3, min: 1, max: 60 },
      { key: "showImages", label: "Show pictures", type: "boolean", default: true },
      { key: "lang", label: "Wikipedia language", type: "select", default: "en", options: [
        { value: "en", label: "English" }, { value: "de", label: "Deutsch" }, { value: "fr", label: "Français" },
        { value: "sv", label: "Svenska" }, { value: "pt", label: "Português" }, { value: "ru", label: "Русский" },
      ] },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "otd" });
    root.appendChild(body);
    const handle = { body, widget, items: [], i: 0 };
    await this.refresh(handle, widget);
    start(handle);
    return handle;
  },
  async refresh(handle, widget) {
    if (widget) handle.widget = widget;
    const s = handle.widget.settings || {};
    const now = new Date();
    await loadInto(handle, {
      load: () => fetchData("on-this-day", { month: now.getMonth() + 1, day: now.getDate(), lang: s.lang || "en" }),
      render: (d) => {
        const key = `${d.month}-${d.day}`;
        // A new day starts the list again; a refresh of the same day keeps its place.
        if (key !== handle.key) { handle.key = key; handle.i = pickStart(d.items.length); }
        handle.items = d.items || [];
        show(handle);
      },
      error: { title: "Can't reach Wikipedia" },
    });
  },
  suspend(handle) { clearInterval(handle.timer); handle.timer = null; },
  resume(handle) { start(handle); },
  destroy(handle) { clearInterval(handle.timer); },
});

// Different displays (and reloads) don't all start on the same story.
const pickStart = (n) => (n ? Math.floor(Math.random() * n) : 0);

function period(handle) {
  return Math.max(1, Math.min(60, Number(handle.widget.settings?.minutes) || 3)) * 60000;
}

function start(handle) {
  clearInterval(handle.timer);
  handle.timer = setInterval(() => {
    if (!handle.items.length) return;
    handle.i = (handle.i + 1) % handle.items.length;
    show(handle);
  }, period(handle));
}

/** "68 years ago", "1 year ago". Exported for tests. */
export function yearsAgo(year, now = new Date()) {
  const n = now.getFullYear() - year;
  return n === 1 ? "1 year ago" : `${n} years ago`;
}

function show(handle) {
  const item = handle.items[handle.i % Math.max(1, handle.items.length)];
  if (!item) {
    handle.body.replaceChildren(el("div", { class: "otd-text" }, [el("div", { class: "otd-story" }, "Nothing listed for today.")]));
    return;
  }
  const s = handle.widget.settings || {};
  const year = item.year < 0 ? `${-item.year} BC` : String(item.year);
  const img = s.showImages !== false && item.image
    ? el("div", { class: "otd-img", role: "img", "aria-label": item.title || "", style: { backgroundImage: `url("${item.image.replace(/"/g, "%22")}")` } })
    : null;
  const prog = el("span", { class: "otd-prog" }, el("i", { style: { animationDuration: `${period(handle)}ms` } }));
  handle.body.classList.toggle("has-img", !!img);
  handle.body.replaceChildren(
    el("div", { class: "otd-text" }, [
      el("div", { class: "otd-year" }, [el("b", {}, year), item.year > 0 ? el("span", {}, yearsAgo(item.year)) : null]),
      el("div", { class: "otd-story" }, item.text),
      el("div", { class: "otd-foot" }, [el("span", {}, "On this day · Wikipedia"), prog]),
    ]),
    ...(img ? [img] : []),
  );
}
