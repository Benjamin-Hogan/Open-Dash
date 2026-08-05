// Stand-in for web/js/widgets/index.js so catalog.js can be tested under node.
//
// The real module is imported by the absolute URL "/widgets/index.js", which
// only resolves in the browser (admin_app.py mounts it there so the admin and
// the dashboard share one registry instance). This fixture exposes the same
// two functions catalog.js uses, over a fixed set of plugins chosen to cover
// the interesting cases: required fields, a password field, a note field, a
// global-key widget, and an unknown category.

const PLUGINS = {
  clock: {
    meta: { label: "Clock", description: "Time and date", category: "basic" },
    schema: { fields: [{ key: "hour12", type: "boolean", default: true }] },
  },
  weather: {
    meta: { label: "Weather", description: "Current conditions and forecast", category: "data" },
    schema: {
      fields: [
        { key: "units", type: "select", default: "imperial" },
        { key: "showForecast", type: "boolean", default: true },
        { key: "_hint", type: "note", label: "Uses the home location" },
      ],
    },
  },
  stocks: {
    meta: { label: "Stocks", description: "A stock ticker with charts", category: "data" },
    schema: {
      fields: [
        { key: "symbols", type: "stock-picker" },
        { key: "_note", type: "note", label: "Needs a Finnhub key" },
      ],
    },
  },
  octoprint: {
    meta: { label: "OctoPrint", description: "3D printer status", category: "data" },
    schema: {
      fields: [
        { key: "url", type: "text" },
        { key: "apiKey", type: "password" },
      ],
    },
  },
  iframe: {
    meta: { label: "Iframe embed", description: "Embed any website", category: "mystery" },
    schema: { fields: [{ key: "url", type: "url-presets", required: true }] },
  },
};

export function get(type) {
  return PLUGINS[type];
}

export function types() {
  return Object.keys(PLUGINS).sort();
}

export function manifest() {
  return types().map((type) => ({
    type,
    meta: PLUGINS[type].meta || {},
    schema: PLUGINS[type].schema || { fields: [] },
  }));
}
