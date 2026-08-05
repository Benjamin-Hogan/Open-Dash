# Display experience bundle — requirements

Date: 2026-07-20. Ships four display-facing features together.

## Features

1. **Pinned heads-up widget** — `heads-up` type with `pinned: true` renders in a fixed overlay across page rotation.
2. **Touch swipe navigation** — horizontal swipes change pages (same pause semantics as page dots).
3. **Random page transitions** — catalog of animated transitions; random mode avoids repeating twice in a row.
4. **Local NAS photos widget** — `photos` type reads images from `PHOTOS_DIR` with path traversal guards.

## Constraints

- Single `PUT /api/config` write path unchanged.
- Page transitions animate pane opacity/transform only (soft-suspend preserved).
- `prefers-reduced-motion` disables fancy transitions.
- One pinned widget recommended; first in config wins.

## Config

- `Widget.pinned: bool`
- `Settings.pageTransition: str` — `off`, `random`, or a catalog id
- Photos widget settings: `folder`, `shuffle`, `intervalSeconds`, `fit`

## Deployment

- Docker: optional `./photos:/app/photos:ro` volume
- Env: `PHOTOS_DIR` (default `/app/photos`)
