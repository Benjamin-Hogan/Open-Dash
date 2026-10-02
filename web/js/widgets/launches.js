// Next launch — the next rocket launch anywhere (Launch Library 2): the
// countdown with its units written out ("T−1 day 2 h"), rocket and mission,
// when it is here and the launch weather, provider and pad. A status pill says
// Go, TBD or Holding; during a hold the clock greys. The next two follow.
import { define } from "./registry.js";
import { el, fetchData, loadInto } from "./dom.js";
import { time, day, nb } from "./fmt.js";

define("launches", {
  meta: {
    label: "Next launch",
    description: "Countdown to the next rocket launch, with the two after it",
    category: "data",
    showTitle: false,
    // Launch Library's free tier allows 15 requests an hour; the server
    // caches for 20 minutes and every display shares that.
    defaultRefreshSeconds: 1200,
  },
  schema: {
    fields: [
      { key: "provider", label: "Only launches by (leave blank for everyone)", type: "text", placeholder: "SpaceX",
        help: "Matches the start of the company's name." },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "launch" });
    root.appendChild(body);
    const handle = { body, widget, data: null };
    await this.refresh(handle, widget);
    handle.timer = setInterval(() => { if (handle.data) render(handle); }, 30000);
    return handle;
  },
  async refresh(handle, widget) {
    if (widget) handle.widget = widget;
    await loadInto(handle, {
      load: () => fetchData("launches"),
      render: (d) => { handle.data = d; render(handle); },
      error: { title: "Can't reach the launch schedule" },
    });
  },
  suspend(handle) { clearInterval(handle.timer); handle.timer = null; },
  resume(handle) {
    if (!handle.timer) handle.timer = setInterval(() => { if (handle.data) render(handle); }, 30000);
    if (handle.data) render(handle);
  },
  destroy(handle) { clearInterval(handle.timer); },
});

/** The countdown as [number, unit] pairs: "1 day 2 h", "5 h 12 min", "38 min". Exported for tests. */
export function tMinus(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  if (d >= 3) return [[d, "days"]];
  if (d >= 1) return h ? [[d, d === 1 ? "day" : "days"], [h, "h"]] : [[d, d === 1 ? "day" : "days"]];
  if (h >= 1) return min ? [[h, "h"], [min, "min"]] : [[h, "h"]];
  return [[min, "min"]];
}

const PILL = {
  Go: ["go", "Go"], TBD: ["tbd", "TBD"], TBC: ["tbd", "TBC"], Hold: ["hold", "Holding"], "In Flight": ["go", "In flight"],
};

function render(handle) {
  const now = Date.now();
  const only = handle.widget.settings?.provider?.trim().toLowerCase();
  const all = (handle.data.launches || [])
    .filter((l) => !only || (l.provider || "").toLowerCase().startsWith(only))
    .map((l) => ({ ...l, at: new Date(l.net) }));
  // A launch that's gone is dropped a few minutes after its time unless it's still flying.
  const list = all.filter((l) => l.at.getTime() > now - 10 * 60000 || l.status === "In Flight");
  if (!list.length) {
    handle.body.replaceChildren(el("div", { class: "ln-none" }, [
      el("div", { class: "ln-n" }, "No launches scheduled"),
      el("div", { class: "ln-r" }, only ? `Nothing coming up from ${handle.widget.settings.provider.trim()}.` : "Check back later."),
    ]));
    return;
  }
  const [next, ...rest] = list;
  const [tone, word] = PILL[next.status] || ["tbd", next.status || "TBD"];
  const holding = next.status === "Hold";
  const gone = next.at.getTime() <= now;
  const clock = gone
    ? el("div", { class: "ln-t" }, "Lift-off")
    : el("div", { class: "ln-t" + (holding ? " frozen" : "") }, ["T−", ...tMinus(next.at - now).flatMap(([n, u]) => [String(n), el("small", {}, u)])]);
  const when = `${day(next.at)} ${time(next.at)}`;
  const weather = next.probability != null && next.probability >= 0 ? `weather ${next.probability}% favourable` : null;
  handle.body.replaceChildren(
    el("div", { class: "ln-top" }, [clock, el("span", { class: `status-pill ${tone}` }, word)]),
    el("div", { class: "ln-what" }, [
      el("div", { class: "ln-n" }, nb(`${next.rocket} · ${next.mission}`)),
      el("div", { class: "ln-r" }, holding
        ? [`Was `, el("b", {}, time(next.at)), weather ? ` · ${weather}` : null]
        : [el("b", {}, when), weather ? ` · ${weather}` : null]),
      el("div", { class: "ln-r" }, [next.provider, next.place].filter(Boolean).join(" · ")),
    ]),
    rest.length ? el("div", { class: "ln-list" }, rest.slice(0, 2).map((l) => el("div", { class: "ln-row" }, [
      el("b", {}, nb(`${l.rocket} · ${l.mission}`)), el("span", {}, day(l.at)),
    ]))) : null,
  );
}
