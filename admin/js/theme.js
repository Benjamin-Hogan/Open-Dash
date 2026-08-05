// Admin theme: dark | light | auto. Independent of the dashboard's own theme
// setting (that one controls what the displays render; this one controls the
// admin chrome), so the two are labelled separately in the UI.
//
// Loaded as a blocking classic script in <head> so the stored choice is on
// <html> before first paint — otherwise a light-theme user gets a dark flash.

(function () {
  const KEY = "admin.theme";
  const VALID = ["dark", "light", "auto"];

  function read() {
    try {
      const v = localStorage.getItem(KEY);
      return VALID.includes(v) ? v : "auto";
    } catch {
      return "auto"; // private mode / storage disabled
    }
  }

  // Switching theme only changes custom properties. Chromium does not reliably
  // re-resolve a *transitioned* property when the var it derives from changes,
  // so an element with `transition: color` can keep painting the old accent
  // until something forces a fresh style resolution. Suppressing transitions
  // across the swap sidesteps it — and an instant theme flip is what you want
  // anyway; nobody wants to watch the UI cross-fade.
  function apply(mode, { animate = false } = {}) {
    const root = document.documentElement;
    if (!animate) {
      root.classList.add("theme-switching");
      // Force a reflow so the suppression is in effect for the swap itself.
      void root.offsetWidth;
    }
    root.dataset.theme = VALID.includes(mode) ? mode : "auto";
    if (!animate) {
      void root.offsetWidth;
      requestAnimationFrame(() => root.classList.remove("theme-switching"));
    }
  }

  apply(read(), { animate: true }); // nothing has rendered yet at first paint

  // Exposed for the Appearance panel; kept on window because this file is a
  // classic script (it must run before the module graph loads).
  window.adminTheme = {
    get: read,
    set(mode) {
      if (!VALID.includes(mode)) return;
      try { localStorage.setItem(KEY, mode); } catch { /* non-fatal */ }
      apply(mode);
    },
  };
})();
