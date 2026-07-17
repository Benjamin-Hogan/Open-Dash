// Widget plugin registry — the ONE contract for every widget type.
//
// Built-in embeds (iframe/image/video/text) and data-backed widgets (weather,
// stocks, ...) all register here the same way. There is no second pipeline.
//
// A plugin is:
//   {
//     meta:   { label, description, category },
//     schema: { fields: [ {key, label, type, ...} ] },  // drives the admin form
//     async mount(el, widget, ctx) -> handle,
//     async refresh(handle, widget),                      // optional
//     suspend(handle, opts?), resume(handle, opts?),      // optional (slideshow / pages)
//       opts.releaseMedia === false → soft pause (page rotation); default hard release
//   }

const _plugins = new Map();

export function define(type, plugin) {
  _plugins.set(type, plugin);
}

export function get(type) {
  return _plugins.get(type);
}

export function has(type) {
  return _plugins.has(type);
}

export function types() {
  return [..._plugins.keys()].sort();
}

export function manifest() {
  // Consumed by the admin to build forms from each plugin's schema.
  return types().map((type) => {
    const p = _plugins.get(type);
    return { type, meta: p.meta || {}, schema: p.schema || { fields: [] } };
  });
}
