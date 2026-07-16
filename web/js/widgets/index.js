// Imports every built-in plugin so it self-registers, then re-exports the
// registry API. Both the dashboard (app.js) and the admin import THIS module, so
// they share one set of widget definitions and schemas.
import "./clock.js";
import "./text.js";
import "./iframe.js";
import "./embed.js";
import "./image.js";
import "./video.js";
import "./pi-stats.js";
import "./weather.js";
import "./space-weather.js";
import "./space-imagery.js";
import "./stocks.js";
import "./youtube-live.js";
import "./slideshow.js";
import "./air-quality.js";
import "./rss.js";
import "./ical.js";
import "./octoprint.js";

export * from "./registry.js";
