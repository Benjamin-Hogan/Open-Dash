// Stocks watchlist. Tickers are chosen in the admin via a search picker (see the
// "stock-picker" field type in the admin form renderer), stored as settings.symbols.
//
// Three views — Compact (sym/price/%), Detailed (+ change$, day range, prev close),
// and Chart (+ sparkline from the backend's history fetch). The admin sets the
// default view; clicking the toggle in the card cycles it live.
import { define } from "./registry.js";
import { el, fetchData, fmtNum, effectiveSettings } from "./dom.js";

const VIEWS = ["Compact", "Detailed", "Chart"];
const RANGE = { "1D": "1d", "5D": "5d", "1M": "1mo", "6M": "6mo", "1Y": "1y" };

define("stocks", {
  meta: { label: "Stocks", description: "Watchlist of tickers", category: "data" },
  schema: {
    fields: [
      // Custom field type the admin renders as a searchable add/remove picker.
      { key: "symbols", label: "Tickers", type: "stock-picker", default: [] },
      { key: "view", label: "Default view", type: "select", options: VIEWS, default: "Compact" },
      { key: "chartRange", label: "Chart range", type: "select", options: Object.keys(RANGE), default: "1M" },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "stocks" });
    root.appendChild(body);
    const handle = { body, widget, view: null };
    handle.rerender = () => this.refresh(handle, handle.widget);
    await this.refresh(handle, widget);
    return handle;
  },
  async refresh(handle, widget) {
    const w = widget || handle.widget;
    const s = effectiveSettings(w);
    const view = handle.view || s.view || "Compact";
    const symbols = Array.isArray(s.symbols) ? s.symbols : String(s.symbols || "").split(",").filter(Boolean);
    const params = { symbols: symbols.join(",") };
    if (view === "Chart") { params.chart = "1"; params.range = RANGE[s.chartRange] || "1mo"; }

    try {
      const d = await fetchData("stocks", params);
      if (d.needsKey) {
        handle.body.replaceChildren(el("div", { class: "widget-error" }, `Set ${d.env} to enable stock quotes`));
        return;
      }
      const quotes = d.quotes || [];
      const rows = quotes.map((q) => renderRow(q, view));
      const list = rows.length
        ? el("div", { class: "stock-list" }, rows)
        : el("div", { class: "widget-empty" }, "No tickers selected");
      handle.body.replaceChildren(viewToggle(handle, view), list);
    } catch {
      handle.body.replaceChildren(el("div", { class: "widget-error" }, "quotes unavailable"));
    }
  },
});

// Clickable view cycler — lets you flip Compact → Detailed → Chart on the card.
function viewToggle(handle, view) {
  const btn = el("button", { class: "stock-toggle", title: "Cycle view" }, view);
  btn.onclick = () => {
    handle.view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length];
    handle.rerender();
  };
  return el("div", { class: "stock-head" }, btn);
}

function renderRow(q, view) {
  const up = (q.changePercent ?? 0) >= 0;
  const cls = up ? "up" : "down";
  const price = q.error ? "—" : `$${fmtNum(q.price, 2)}`;
  const chg = q.error || q.changePercent == null ? "—" : `${up ? "▲" : "▼"} ${fmtNum(Math.abs(q.changePercent), 2)}%`;

  const cells = [
    el("div", { class: "stock-sym" }, q.symbol),
    el("div", { class: "stock-price" }, price),
    el("div", { class: "stock-chg " + cls }, chg),
  ];

  if (view === "Detailed" && !q.error) {
    const chgAbs = q.change == null ? "—" : `${up ? "+" : "−"}$${fmtNum(Math.abs(q.change), 2)}`;
    const range = q.low != null && q.high != null ? `$${fmtNum(q.low, 2)}–$${fmtNum(q.high, 2)}` : "—";
    const prev = q.prevClose != null ? `$${fmtNum(q.prevClose, 2)}` : "—";
    cells.push(el("div", { class: "stock-sub" }, [
      el("span", {}, `Chg ${chgAbs}`),
      el("span", {}, `Day ${range}`),
      el("span", {}, `Prev ${prev}`),
    ]));
    return el("div", { class: "stock-row detailed" }, cells);
  }

  if (view === "Chart") {
    cells.push(q.series && q.series.length >= 2
      ? sparkline(q.series, up)
      : el("div", { class: "stock-spark" }));
    return el("div", { class: "stock-row chart" }, cells);
  }

  return el("div", { class: "stock-row" }, cells);
}

// Inline SVG sparkline — no library. Colored by overall direction of the series.
function sparkline(series, up) {
  const w = 100, h = 28, pad = 2;
  const min = Math.min(...series), max = Math.max(...series);
  const span = (max - min) || 1;
  const n = series.length;
  const pts = series.map((v, i) => {
    const x = (n === 1 ? 0 : (i / (n - 1)) * (w - 2 * pad)) + pad;
    const y = h - pad - ((v - min) / span) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = up ? "#3fc77a" : "#ef5f6b";
  return el("div", {
    class: "stock-spark",
    html: `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/></svg>`,
  });
}
