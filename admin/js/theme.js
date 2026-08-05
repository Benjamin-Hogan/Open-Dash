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

  function apply(mode) {
    document.documentElement.dataset.theme = VALID.includes(mode) ? mode : "auto";
  }

  apply(read());

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
