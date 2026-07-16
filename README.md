# Open-Dash

A glanceable, kiosk-style wall dashboard for a Raspberry Pi 5 + display.
Anyone on the LAN reconfigures it from a browser — no JSON editing, no redeploy,
no page refresh. `web/dashboard.config.json` is the single source of truth; the
admin writes it and every dashboard live-reloads over Server-Sent Events.

## Architecture (the v3 shape)

- **Typed, versioned config spine.** `server/shared/schema.py` (Pydantic) is the
  one model for the whole document. Bad widgets are rejected at the API, never at
  render. `version` drives optimistic concurrency.
- **One write path.** `PUT /api/config` is version-gated (409 on stale → the
  admin re-syncs, no silent clobber), writes atomically (temp + `os.replace`),
  and keeps timestamped backups in `web/backups/`. No granular per-widget API.
- **One widget contract.** Every type — embeds *and* data widgets — is an ES
  module exposing `{ meta, schema, mount, refresh?, suspend?, resume? }`
  (`web/js/widgets/`). No second pipeline.
- **Symmetric backend provider registry.** Data widgets read from a generic
  `GET /api/data/{provider}` backed by a shared TTL cache. Adding a data widget =
  one provider file + one plugin file.
- **Pages + slideshow.** The config holds multiple named **pages** (layouts).
  Slideshow mode rotates through them on a timer (global default + optional
  per-page override). Old single-`widgets` configs auto-migrate to one page
  (`server/shared/migrations.py`).
- **Self-generating admin.** The admin imports the same widget registry and
  builds forms from each plugin's `schema`. Position/size are edited by **dragging
  and resizing** widgets on a visual grid canvas (per page). Global **alert**
  auto-dismiss timing (per severity) is editable under **Alerts**.
- **Two apps, one process.** Admin (`:8081`) and dashboard (`:8082`) share
  in-process singletons (config, cache, SSE hub, geo), so they must run together
  (`python -m server.run`).

## Run

### Docker (recommended)
```sh
cp .env.example .env   # optional API keys
docker compose up --build
```

`compose.yaml` bind-mounts `server/`, `web/`, and `admin/` and runs the app under
[`watchfiles`](https://pypi.org/project/watchfiles/) (bundled with
`uvicorn[standard]`), so **code edits hot-reload with no rebuild**: change any file
and the server restarts; the asset-version bump then makes the kiosk hard-reload
itself. Config/secrets persist in the `dashboard-data` volume, untouched by reloads.

### Local
```sh
pip install -e .
python -m server.run
```

- Dashboard: http://localhost:8082
- Admin:     http://localhost:8081

## Widgets

Built in: `clock`, `text`, `iframe`, `embed`, `image`, `video`, `pi-stats`,
`weather` (Open-Meteo, keyless), `space-weather` (NOAA, keyless), `stocks`
(Finnhub — searchable ticker picker in the admin), `octoprint` (printer status,
progress, filament, connection flags — prefer LAN IP over `.local`; API key per
widget or global; webcam is a separate `image`/`iframe` pointed at
`/webcam/?action=stream`), `youtube-live` (quota-aware
two-tier cache + broken-embed auto-recovery), `slideshow` (rotates child widgets
with real media suspend/resume).

`embed` runs a pasted `<div>+<script>` snippet (TradingView and similar) inside a
sandboxed iframe via `srcdoc` — for third-party widgets that ship code rather than
a URL (use `iframe` for plain embeddable pages). In the admin, pick a TradingView
preset to auto-fill the snippet; a live preview renders as you edit. Like the other
embeds, it releases its scripts/sockets when off-screen in a slideshow.

Add a widget type:
1. `server/providers/<name>.py` — a `Provider` subclass (if it needs data); add it to `load_builtin()`.
2. `web/js/widgets/<name>.js` — `define("<name>", { meta, schema, mount, ... })`; add it to `web/js/widgets/index.js`.

That's it — the admin form and the data route pick it up automatically.

## Security

The admin is **unauthenticated by design** (trusted LAN; a startup warning is
logged). Some embeds may disable the iframe sandbox to run third-party JS. Do not
port-forward the admin without adding an `ADMIN_TOKEN` layer first (planned).

## API keys (optional, graceful without)

Two ways to set them, either works:

1. **Admin panel** → **API keys** button. Stored server-side in
   `data/secrets.json` (never under `web/`, never returned to the browser —
   status is masked). Saving a key clears the cache and live-refreshes dashboards.
2. **Environment variable** (`FINNHUB_API_KEY`, `YOUTUBE_API_KEY`). An env var
   takes precedence over a UI-set value and locks that field in the admin.

| Key | Widget |
| --- | --- |
| `FINNHUB_API_KEY` | `stocks` |
| `YOUTUBE_API_KEY` | `youtube-live` |
| `OCTOPRINT_API_KEY` | `octoprint` (global fallback; per-printer keys can also be set in each widget) |

Weather and space-weather need no key.

## Data & persistence

Live config, backups, and secrets live in `data/` (outside `web/`, so never
statically served). The starter config ships as `web/dashboard.seed.json` and is
copied to `data/dashboard.config.json` on first run. In Docker this is a named
volume (`dashboard-data`) — it survives rebuilds and avoids Docker Desktop's
network-drive bind-mount problems.
