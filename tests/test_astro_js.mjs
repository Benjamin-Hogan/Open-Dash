// Astronomy helpers behind the Sun & Moon and World clocks widgets, checked
// against published values (timeanddate.com / USNO), within a few minutes.
import assert from "node:assert/strict";
import { sunTimes, isDaylight, sunElevation, moonPhase, moonPath } from "../web/js/widgets/astro.js";

const minutes = (a, b) => Math.abs(a.getTime() - b.getTime()) / 60000;

// Phoenix (no DST, UTC-7), 2026-10-01: sunrise ~06:22, sunset ~18:12 local.
{
  const t = sunTimes(new Date("2026-10-01T19:00:00Z"), 33.45, -112.07);
  assert.ok(minutes(t.sunrise, new Date("2026-10-01T13:22:00Z")) < 5, `sunrise ${t.sunrise.toISOString()}`);
  assert.ok(minutes(t.sunset, new Date("2026-10-02T01:12:00Z")) < 5, `sunset ${t.sunset.toISOString()}`);
}

// London, 2026-06-21: sunrise ~04:43 BST (03:43Z), sunset ~21:21 BST (20:21Z).
{
  const t = sunTimes(new Date("2026-06-21T12:00:00Z"), 51.507, -0.128);
  assert.ok(minutes(t.sunrise, new Date("2026-06-21T03:43:00Z")) < 5, `london rise ${t.sunrise.toISOString()}`);
  assert.ok(minutes(t.sunset, new Date("2026-06-21T20:21:00Z")) < 5, `london set ${t.sunset.toISOString()}`);
}

// Polar night: Tromsø in late December has no sunrise.
{
  const t = sunTimes(new Date("2026-12-21T12:00:00Z"), 69.65, 18.96);
  assert.equal(t.polar, "night");
  assert.equal(t.sunrise, null);
}

// Day/night by elevation: New York at 8:58 PM EDT on Oct 1 is night; Tokyo
// at 9:58 AM JST on Oct 2 is day.
{
  const at = new Date("2026-10-02T00:58:00Z");
  assert.equal(isDaylight(at, 40.71, -74.01), false, "NYC 8:58 PM should be night");
  assert.equal(isDaylight(at, 35.68, 139.69), true, "Tokyo 9:58 AM should be day");
  assert.ok(sunElevation(new Date("2026-06-21T19:00:00Z"), 33.45, -112.07) > 75, "Phoenix summer noon sun is high");
}

// Moon: full moon 2026-09-26 16:49Z; new moon 2026-10-10 15:50Z (USNO).
{
  const full = moonPhase(new Date("2026-09-26T16:49:00Z"));
  assert.ok(full.illumination > 0.98, `full illum ${full.illumination}`);
  assert.equal(full.name, "Full moon");
  const now = moonPhase(new Date("2026-10-02T00:58:00Z"));
  assert.equal(now.name, "Waning gibbous");
  assert.equal(now.waxing, false);
  // USNO: about 69% illuminated at that moment.
  assert.ok(Math.abs(now.illumination - 0.69) < 0.04, `illumination ${now.illumination}`);
  // Quarter moons are about half lit and named as such near the moment.
  const lq = moonPhase(new Date("2026-10-03T13:25:00Z"));
  assert.equal(lq.name, "Last quarter");
  assert.ok(Math.abs(lq.illumination - 0.5) < 0.08, `last quarter illum ${lq.illumination}`);
  // True phase times (Meeus ch. 49): within a few minutes of USNO, so the
  // displayed date is right in every time zone. The mean phase alone was up
  // to ~18 h out and showed "New moon Oct 11" in Phoenix for Oct 10.
  assert.ok(minutes(now.nextFull, new Date("2026-10-26T04:12:00Z")) < 10, `next full ${now.nextFull.toISOString()}`);
  assert.ok(minutes(now.nextNew, new Date("2026-10-10T15:50:00Z")) < 10, `next new ${now.nextNew.toISOString()}`);
  const nm = moonPhase(new Date("2026-10-10T15:50:00Z"));
  assert.ok(nm.illumination < 0.02, `new illum ${nm.illumination}`);
  // More known instants (USNO): new 2026-01-18 19:52Z, full 2026-03-03 11:38Z.
  assert.ok(minutes(moonPhase(new Date("2026-01-10T00:00:00Z")).nextNew, new Date("2026-01-18T19:52:00Z")) < 10);
  assert.ok(minutes(moonPhase(new Date("2026-02-25T00:00:00Z")).nextFull, new Date("2026-03-03T11:38:00Z")) < 10);
}

// The lit-area path is a closed SVG path for every phase.
for (const f of [0, 0.25, 0.5, 0.75, 1]) {
  for (const waxing of [true, false]) {
    assert.match(moonPath(f, waxing, 50, 50, 40), /^M50 10 A40 40 .*Z$/);
  }
}

console.log("astro ok");
