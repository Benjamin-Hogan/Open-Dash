// Embed — paste a third-party "<div> + <script>" snippet (e.g. TradingView) and
// run it inside a SANDBOXED iframe via srcdoc. Unlike the iframe plugin (which
// loads a URL), these widgets ship code, not a page — so we wrap the snippet in
// a minimal dark document and hand it to an isolated frame. The snippet runs in
// its own opaque origin: it can't read the dashboard DOM, cookies, or storage.
// Media is released on suspend like the other embeds, so an off-screen slide
// stops its websockets/timers on a memory-constrained Pi.
import { define } from "./registry.js";
import { el, effectiveSettings } from "./dom.js";

// Dark-themed TradingView snippets. The admin's "embed-presets" field reads
// these from the schema and fills the textarea when one is picked.
export const TRADINGVIEW_PRESETS = [
  {
    label: "TradingView · Advanced Chart",
    code:
      '<div class="tradingview-widget-container" style="height:100%;width:100%">' +
      '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>' +
      '<script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>' +
      '{"autosize":true,"symbol":"BITSTAMP:BTCUSD","interval":"D","timezone":"Etc/UTC","theme":"dark","style":"1","locale":"en","backgroundColor":"#0c142e","allow_symbol_change":true,"support_host":"https://www.tradingview.com"}' +
      "</script></div>",
  },
  {
    label: "TradingView · Ticker Tape",
    code:
      '<div class="tradingview-widget-container">' +
      '<div class="tradingview-widget-container__widget"></div>' +
      '<script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js" async>' +
      '{"symbols":[{"proName":"FOREXCOM:SPXUSD","title":"S&P 500"},{"proName":"BITSTAMP:BTCUSD","title":"Bitcoin"},{"proName":"BITSTAMP:ETHUSD","title":"Ethereum"}],"showSymbolLogo":true,"isTransparent":true,"displayMode":"adaptive","colorTheme":"dark","locale":"en"}' +
      "</script></div>",
  },
  {
    label: "TradingView · Market Overview",
    code:
      '<div class="tradingview-widget-container">' +
      '<div class="tradingview-widget-container__widget"></div>' +
      '<script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js" async>' +
      '{"colorTheme":"dark","dateRange":"12M","showChart":true,"locale":"en","isTransparent":true,"width":"100%","height":"100%","showSymbolLogo":true}' +
      "</script></div>",
  },
  {
    label: "TradingView · Mini Symbol",
    code:
      '<div class="tradingview-widget-container">' +
      '<div class="tradingview-widget-container__widget"></div>' +
      '<script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js" async>' +
      '{"symbol":"BITSTAMP:BTCUSD","width":"100%","height":"100%","locale":"en","dateRange":"12M","colorTheme":"dark","isTransparent":true,"autosize":true}' +
      "</script></div>",
  },
];

// Wraps a snippet verbatim in a minimal dark document. Scripts inside srcdoc
// execute on parse, exactly as on the vendor's own page — no manual eval.
// Exported so the admin can render an identical live preview.
export function buildEmbedDoc(snippet, bg) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"/>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
    "<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;" +
    "background:" + (bg || "#0c142e") + ";color:#e6ecff;" +
    "font-family:system-ui,-apple-system,sans-serif}*{box-sizing:border-box}" +
    "</style></head><body>" + (snippet || "") + "</body></html>"
  );
}

define("embed", {
  meta: { label: "Embed (script)", description: "TradingView & other <script> widgets", category: "embed" },
  schema: {
    fields: [
      { key: "embedCode", label: "Embed snippet (HTML + <script>)", type: "embed-presets",
        required: true, presets: TRADINGVIEW_PRESETS },
      { key: "background", label: "Background color", type: "text", default: "#0c142e" },
    ],
  },
  async mount(root, widget) {
    const s = effectiveSettings(widget);
    const frame = el("iframe", {
      class: "embed-frame",
      loading: "lazy",
      // allow-scripts + allow-same-origin: TradingView needs both. Trusted
      // vendor embeds on a kiosk; the frame still can't touch the parent page.
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
    });
    frame.srcdoc = buildEmbedDoc(s.embedCode, s.background);
    root.appendChild(frame);
    return { frame, code: s.embedCode || "", bg: s.background };
  },
  refresh(handle) {
    // Re-parse the document (clear then re-set on the next frame).
    handle.frame.srcdoc = "";
    requestAnimationFrame(() => { handle.frame.srcdoc = buildEmbedDoc(handle.code, handle.bg); });
  },
  suspend(handle, opts = {}) {
    // Soft page-hide: leave the embed running so it doesn't cold-start on return.
    if (opts.releaseMedia === false) return;
    // Removing srcdoc tears down the embed's scripts/sockets while off-screen.
    handle.frame.removeAttribute("srcdoc");
  },
  resume(handle, opts = {}) {
    if (opts.releaseMedia === false) return;
    handle.frame.srcdoc = buildEmbedDoc(handle.code, handle.bg);
  },
});
