# Open-Dash feature ideation

Surprise-me pass over Open-Dash (Pi + TV kiosk dashboard), dated 2026-07-17.
Chosen follow-up for requirements: **#1 Scene modes** (see [`docs/plans/2026-07-17-001-feat-scene-modes-plan.md`](../plans/2026-07-17-001-feat-scene-modes-plan.md)).

## Grounding

- **Spine:** typed config (`server/shared/schema.py`), one `PUT /api/config`, widget plugins + providers, pages + rotation, SSE live-reload.
- **Already strong:** multi-page slideshow, per-device prefs (`server/shared/devices.py`), alert engine (OctoPrint / NWS / space weather), suspend/resume for Pi memory.
- **Underused leverage:** `Widget.variants` exists but is barely exercised; devices can filter pages but not alerts; alert sources are hardcoded to three.
- **Documented gap:** `ADMIN_TOKEN` is planned, not built (`README.md`).
- **Recent signal:** alert TTL/dismiss and displays-panel races — alerts + multi-display are the active edge.

## External research (competitor signal)

`parallel-cli` was installed (v0.7.1) but not authenticated in this environment (`PARALLEL_API_KEY` unset / no login). Competitor signal below used Cursor web search instead.

Adjacent products treat **context switching** as a first-class wall-display need:

- [Magic Frame](https://magicframe.dev/) positions the same screen as dashboard *or* picture frame, with HA-triggered show/hide and per-view URLs ([Magic Frame HA community post](https://community.home-assistant.io/t/magic-frame-self-hosted-dashboard-for-family-boards-wall-monitors-and-picture-frames-with-deep-ha-integration-v1-0-released/1011749); [v1.1.0 HA-triggers](https://github.com/jeremiaa/magic-frame/releases/tag/v1.1.0)).
- Home Assistant wall setups commonly automate **day/night** via helpers + dashboard navigate or theme flips ([HA day/night navigate thread](https://community.home-assistant.io/t/show-dashboards-during-the-day/72257); [dos dashboard night boolean](https://github.com/scobbyd/ha-dos-dashboard)).
- [Lovelace WallPanel](https://github.com/haggs/lovelace-wallpanel) adds idle screensaver / kiosk chrome hide — ambient mode without a full second product.

**Implication for Open-Dash:** Scene modes should compose pages + theme + variants (and later optional events), not require becoming an HA dashboard. Event/HA triggers are a v2 challenger, not v1 scope.

### Sources

- [Magic Frame](https://magicframe.dev/)
- [jeremiaa/magic-frame](https://github.com/jeremiaa/magic-frame)
- [Magic Frame v1.0 HA community](https://community.home-assistant.io/t/magic-frame-self-hosted-dashboard-for-family-boards-wall-monitors-and-picture-frames-with-deep-ha-integration-v1-0-released/1011749)
- [Magic Frame v1.1.0 release](https://github.com/jeremiaa/magic-frame/releases/tag/v1.1.0)
- [HA show dashboards during the day](https://community.home-assistant.io/t/show-dashboards-during-the-day/72257)
- [scobbyd/ha-dos-dashboard](https://github.com/scobbyd/ha-dos-dashboard)
- [haggs/lovelace-wallpanel](https://github.com/haggs/lovelace-wallpanel)
- [jvenuto80/Dynamic-HA-Dashboard (Glance)](https://github.com/jvenuto80/Dynamic-HA-Dashboard)

## Top ideas (ranked)

### 1. Scene modes (context presets) — selected

Named scenes (e.g. Morning, Print watch, Night ambient) that flip page set, theme, widget variants, and rotation timing in one shot — by schedule, manual admin toggle, or (later) event.

**Basis:** `Schedule`, `Variant`, device `pages` filter already exist as separate knobs.

### 2. User-defined alert rules (+ webhook in)

Rules over any provider payload (and optional inbound webhooks) → banner alerts, instead of only three built-in sources.

### 3. Per-display alert and content routing

Extend device prefs so each display chooses alert sources/severities as well as pages.

### 4. ADMIN_TOKEN (trusted-LAN → optional lock)

Optional shared token for admin write routes; dashboard read stays open on LAN.

### 5. Home Assistant / MQTT bridge

Data widget + optional alert source mirroring HA entities or MQTT topics.

### 6. Glance / declutter modes

Display-level density: full grid vs chrome-minimal strip, switchable by schedule.

### 7. Shareable widget packs / recipes

Export/import a page or widget group; optional keyless provider pack (transit, tides, earthquakes).

## Rejected (sample)

| Idea | Why cut |
|------|---------|
| Config undo stack beyond backups | Useful polish; fails meeting-test vs scenes/alerts |
| Auto-magic layout from templates | Generic; fights the intentional canvas editor |
| Widgets messaging each other | High architecture cost; weak basis |
| Voice / zero-admin setup | Subject drift; expensive for a LAN kiosk |
| Fleet orchestration for 100 displays | Wrong scale for Pi-home product |
| Break single `PUT /api/config` write path | Fights the v3 spine |

## Next step

Requirements for Scene modes are captured in [`docs/plans/2026-07-17-001-feat-scene-modes-plan.md`](../plans/2026-07-17-001-feat-scene-modes-plan.md). Use `ce-plan` when ready to design implementation.
