// Service status — is the NAS / Home Assistant / router up? Checked from the
// Pi (provider "service-status"), which reads the list from this widget's
// settings by id. The headline is the answer: "All 10 up" or "NAS is down".
// Down rows sort first and are tinted; slow ones are amber; each row shows the
// last hour as twelve 5-minute blocks. When the list doesn't fit, healthy
// services collapse first into "+4 more, all up".
import { define } from "./registry.js";
import { el, fetchData, loadInto, stateView } from "./dom.js";
import { span, nb } from "./fmt.js";

const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>',
};
const RANK = { down: 0, invalid: 1, slow: 2, up: 3 };

define("service-status", {
  meta: {
    label: "Service status",
    description: "Up or down for the things on your network: NAS, Home Assistant, router",
    category: "system",
    showTitle: false,
    defaultRefreshSeconds: 60,
  },
  schema: {
    fields: [
      {
        key: "services", label: "Services to check", type: "list", itemLabel: "Service", addLabel: "+ Add a service",
        emptyText: "Nothing to check yet.",
        default: [],
        newItem: { name: "", target: "" },
        itemTitle: (s, i) => s.name || s.target || `Service ${i + 1}`,
        itemFields: [
          { key: "name", label: "Name", type: "text", placeholder: "NAS" },
          { key: "target", label: "Address", type: "text", required: true, placeholder: "http://nas.local:5000 or 192.168.1.1:53",
            help: "A web address, or host:port to just check it accepts connections." },
        ],
      },
      { key: "slowMs", label: "Slow when a check takes longer than (ms)", type: "number", default: 1000, min: 50 },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "svc" });
    root.appendChild(body);
    const handle = { body, widget, data: null };
    handle.ro = new ResizeObserver(() => { if (handle.data) render(handle); });
    handle.ro.observe(body);
    await this.refresh(handle, widget);
    return handle;
  },
  async refresh(handle, widget) {
    if (widget) handle.widget = widget;
    const list = (handle.widget.settings?.services || []).filter((s) => s?.target);
    if (!list.length) {
      handle.data = null;
      handle.body.replaceChildren(stateView({
        icon: "list", title: "Service status: nothing to check yet",
        body: "Add the NAS, router or anything else on your network in this widget's settings.",
        where: "Admin › Layout › Service status",
      }));
      return;
    }
    await loadInto(handle, {
      load: () => fetchData("service-status", { widgetId: handle.widget.id }),
      render: (d) => { handle.data = d; render(handle); },
      error: { title: "Can't run the checks" },
    });
  },
  destroy(handle) { handle.ro?.disconnect(); },
});

/** The headline: { tone, title, sub }. Exported for tests. */
export function headline(services, now = Date.now()) {
  const down = services.filter((s) => s.state === "down" || s.state === "invalid");
  const slow = services.filter((s) => s.state === "slow");
  const up = services.length - down.length;
  if (down.length === 1) {
    const s = down[0];
    return {
      tone: "bad", title: `${s.name} is down`,
      sub: s.state === "invalid" ? "Its address can't be checked" : `For ${span(now - s.since)} · ${up} other${up === 1 ? "" : "s"} up`,
    };
  }
  if (down.length > 1) {
    return { tone: "bad", title: `${down.length} services down`, sub: `${down.map((s) => s.name).join(", ")}` };
  }
  return {
    tone: "ok", title: services.length === 1 ? `${services[0].name} is up` : `All ${services.length} up`,
    sub: slow.length ? `${slow.map((s) => s.name).join(", ")} ${slow.length === 1 ? "is" : "are"} slow` : "Checked every minute",
  };
}

const msText = (s) => (s.state === "down" ? "Down" : s.state === "invalid" ? "Bad address"
  : s.ms == null ? "—" : s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)} s` : `${s.ms} ms`);

function render(handle) {
  const services = [...(handle.data.services || [])]
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || a.i - b.i);
  if (!services.length) return;
  const h = headline(services);
  const head = el("div", { class: `svc-head tone-${h.tone}` }, [
    el("span", { class: "svc-badge", html: h.tone === "ok" ? ICON.check : ICON.x }),
    el("div", { class: "svc-head-text" }, [el("div", { class: "svc-title" }, nb(h.title)), el("div", { class: "svc-sub" }, h.sub)]),
  ]);
  const list = el("div", { class: "svc-list" });
  handle.body.replaceChildren(head, list);
  const row = (s) => el("div", { class: `svc-row ${s.state}` }, [
    el("span", { class: "svc-dot" }),
    el("span", { class: "svc-name" }, nb(s.name)),
    el("span", { class: "svc-ms" }, msText(s)),
    el("span", { class: "svc-hist", "aria-hidden": "true" },
      (s.history || []).map((b) => el("i", { class: b === "down" ? "x" : b === "slow" ? "w" : b ? "" : "n" }))),
  ]);
  // Add rows while they fit; the healthy remainder collapses into one line.
  // Measured top-aligned: space-evenly centres overflow, hiding half of it
  // from scrollHeight.
  list.style.alignContent = "start";
  const rows = services.map(row);
  for (let k = 0; k < rows.length; k++) {
    list.appendChild(rows[k]);
    if (list.scrollHeight > list.clientHeight + 1 && k > 0) {
      rows[k].remove();
      // Make room for the "+N more" line too.
      // Measured with its text in place: an empty line is shorter.
      const more = el("div", { class: "svc-more" }, "+0 more, all up");
      list.appendChild(more);
      while (list.scrollHeight > list.clientHeight + 1 && list.children.length > 2) list.children[list.children.length - 2].remove();
      const hidden = services.slice(list.children.length - 1);
      const allUp = hidden.every((s) => s.state === "up");
      more.textContent = `+${hidden.length} more${allUp ? ", all up" : ""}`;
      break;
    }
  }
  list.style.alignContent = "";
}
