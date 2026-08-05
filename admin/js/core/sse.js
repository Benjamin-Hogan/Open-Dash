// Server-Sent Events subscription.
//
// The admin never listened to this stream, which is why it only ever discovered
// an outside change by eating a 409 at save time — after the user had already
// done the work. Subscribing means we can warn *before* Save, and silently
// re-sync when there's nothing local to lose.
//
// Events broadcast by the server (server/shared/events.py):
//   connected · config-changed {version} · refresh · alert · alert-cleared ·
//   device-prefs

const listeners = new Map(); // event name -> Set<fn>
let source = null;
let retry = null;

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

function emit(event, data) {
  for (const fn of listeners.get(event) || []) {
    try { fn(data); } catch (e) { console.error(`sse ${event} handler:`, e); }
  }
}

function bind(name) {
  source.addEventListener(name, (e) => {
    let data = null;
    try { data = e.data ? JSON.parse(e.data) : null; } catch { data = e.data; }
    emit(name, data);
  });
}

export function connect() {
  if (source) return;
  source = new EventSource("/api/events");

  for (const name of ["connected", "config-changed", "refresh", "alert", "alert-cleared", "device-prefs"]) {
    bind(name);
  }

  source.addEventListener("open", () => emit("_status", { online: true }));
  source.addEventListener("error", () => {
    emit("_status", { online: false });
    // EventSource reconnects on its own, but only while the connection is in a
    // recoverable state. A hard CLOSED means we own the retry.
    if (source.readyState === EventSource.CLOSED) {
      source = null;
      clearTimeout(retry);
      retry = setTimeout(connect, 3000);
    }
  });
}

export function disconnect() {
  clearTimeout(retry);
  source?.close();
  source = null;
}
