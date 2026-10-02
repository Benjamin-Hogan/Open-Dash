// Low-precision solar and lunar astronomy for the Sun & Moon and World clocks
// widgets. Pure functions, no network, no DOM, so they run on the display and
// in Node tests alike.
//
// Accuracy: sunrise/sunset within a couple of minutes (the Sun & Moon widget
// prefers the weather service's times when it has them), solar elevation
// within a fraction of a degree, new and full moon times within minutes.
// Plenty for a wall display; not for navigation.

const RAD = Math.PI / 180;
const J2000 = 2451545.0;

export const toJulian = (date) => date.getTime() / 86400000 + 2440587.5;
export const fromJulian = (jd) => new Date((jd - 2440587.5) * 86400000);

/** Sun's elevation above the horizon in degrees at `date` for lat/lon. */
export function sunElevation(date, lat, lon) {
  const d = toJulian(date) - J2000;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const H = ((gmst * 15 + lon - ra) % 360) * RAD;
  const phi = lat * RAD;
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) / RAD;
}

/** Is it daytime (sun above the horizon, refraction included) at that place? */
export function isDaylight(date, lat, lon) {
  return sunElevation(date, lat, lon) > -0.833;
}

/**
 * Sunrise, solar noon and sunset for the solar day nearest `date` at lat/lon
 * (the "sunrise equation"). Returns Dates; rise/set are null during polar day
 * or night, with `polar` saying which.
 */
export function sunTimes(date, lat, lon) {
  const n = Math.round(toJulian(date) - J2000 - 0.0009 + lon / 360);
  const jStar = n + 0.0009 - lon / 360;
  const M = ((357.5291 + 0.98560028 * jStar) % 360) * RAD;
  const C = 1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M);
  const lambda = ((M / RAD + C + 180 + 102.9372) % 360) * RAD;
  const jTransit = J2000 + jStar + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * lambda);
  const sinDec = Math.sin(lambda) * Math.sin(23.4397 * RAD);
  const cosDec = Math.cos(Math.asin(sinDec));
  const phi = lat * RAD;
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(phi) * sinDec) / (Math.cos(phi) * cosDec);
  const noon = fromJulian(jTransit);
  if (cosW > 1) return { sunrise: null, noon, sunset: null, polar: "night" };
  if (cosW < -1) return { sunrise: null, noon, sunset: null, polar: "day" };
  const w = Math.acos(cosW) / RAD / 360;
  return { sunrise: fromJulian(jTransit - w), noon, sunset: fromJulian(jTransit + w), polar: null };
}

const PHASES = [
  "New moon", "Waxing crescent", "First quarter", "Waxing gibbous",
  "Full moon", "Waning gibbous", "Last quarter", "Waning crescent",
];

/**
 * Julian day (TT) of the true new (`full = false`) or full moon for lunation
 * number k, after Meeus, Astronomical Algorithms ch. 49 — the mean phase plus
 * its main periodic corrections. Good to about a minute; the mean phase alone
 * can be ~18 hours out, enough to put "New moon" on the wrong day.
 */
function truePhase(k, full) {
  if (full) k += 0.5;
  const T = k / 1236.85;
  let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T * T
    - 0.00000015 * T ** 3 + 0.00000000073 * T ** 4;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
  const M = (2.5534 + 29.1053567 * k - 0.0000014 * T * T - 0.00000011 * T ** 3) * RAD;
  const Mp = (201.5643 + 385.81693528 * k + 0.0107582 * T * T + 0.00001238 * T ** 3 - 0.000000058 * T ** 4) * RAD;
  const F = (160.7108 + 390.67050284 * k - 0.0016118 * T * T - 0.00000227 * T ** 3 + 0.000000011 * T ** 4) * RAD;
  const Om = (124.7746 - 1.56375588 * k + 0.0020672 * T * T + 0.00000215 * T ** 3) * RAD;
  const s = Math.sin;
  const [a, b] = full ? [-0.40614, 0.17302] : [-0.4072, 0.17241];
  jde += a * s(Mp) + b * E * s(M)
    + (full ? 0.01614 : 0.01608) * s(2 * Mp) + (full ? 0.01043 : 0.01039) * s(2 * F)
    + (full ? 0.00734 : 0.00739) * E * s(Mp - M) - (full ? 0.00515 : 0.00514) * E * s(Mp + M)
    + (full ? 0.00209 : 0.00208) * E * E * s(2 * M) - 0.00111 * s(Mp - 2 * F)
    - 0.00057 * s(Mp + 2 * F) + 0.00056 * E * s(2 * Mp + M) - 0.00042 * s(3 * Mp)
    + 0.00042 * E * s(M + 2 * F) + 0.00038 * E * s(M - 2 * F) - 0.00024 * E * s(2 * Mp - M)
    - 0.00017 * s(Om);
  return jde - 69 / 86400; // TT → UT (ΔT ≈ 69 s)
}

/** The first true new or full moon after Julian day `jd`. */
function nextPhase(jd, full) {
  let k = Math.floor((jd - 2451550.09766) / 29.530588861) - 1;
  for (let i = 0; i < 4; i++, k++) {
    const t = truePhase(k, full);
    if (t > jd) return t;
  }
  return truePhase(k, full);
}

/**
 * Moon phase at `date`: age in days since the last new moon, illuminated
 * fraction (0–1), whether it's waxing, a name, and the next full and new moons.
 */
export function moonPhase(date) {
  const jd = toJulian(date);
  // The lunation we're in: last true new moon at or before now, and the next.
  let k = Math.floor((jd - 2451550.09766) / 29.530588861) + 1;
  while (truePhase(k, false) > jd) k--;
  const prevNew = truePhase(k, false);
  const full = truePhase(k, true);
  const nextNew = truePhase(k + 1, false);
  const age = jd - prevNew;
  const waxing = jd < full;
  // The two halves of a lunation aren't equal (new→full can be 15.6 days and
  // full→new 13.8), so interpolate within the half we're in: 0 at new, 1 at
  // full. A single even cycle had Oct 1 2026 at 63% lit; it was ~69%.
  const t = waxing ? (jd - prevNew) / (full - prevNew) : 1 - (jd - full) / (nextNew - full);
  const illumination = (1 - Math.cos(Math.PI * t)) / 2;
  // A principal phase (new, first quarter, full, last quarter) is a moment, so
  // its name holds only within about a day of it; in between, the moon is a
  // crescent or gibbous. (Equal eighths would call it "Last quarter" for 3.7 days.)
  const moments = [prevNew, (prevNew + full) / 2, full, (full + nextNew) / 2, nextNew];
  const near = moments.findIndex((m) => Math.abs(jd - m) <= 1);
  const name = near >= 0
    ? PHASES[(near * 2) % 8]
    : PHASES[waxing ? (t < 0.5 ? 1 : 3) : (t > 0.5 ? 5 : 7)];
  return {
    age,
    illumination,
    waxing,
    name,
    nextFull: fromJulian(nextPhase(jd, true)),
    nextNew: fromJulian(nextNew),
  };
}

/**
 * SVG path for the lit part of a moon disc of radius r centred at (cx, cy),
 * as seen from the northern hemisphere (waxing = lit on the right).
 */
export function moonPath(illumination, waxing, cx, cy, r) {
  const rx = Math.abs(1 - 2 * illumination) * r;
  const gibbous = illumination > 0.5;
  const top = `${cx} ${cy - r}`;
  const bottom = `${cx} ${cy + r}`;
  // Outer limb: the lit half-circle. Terminator: an ellipse arc back to the top.
  return waxing
    ? `M${top} A${r} ${r} 0 0 1 ${bottom} A${rx} ${r} 0 0 ${gibbous ? 1 : 0} ${top}Z`
    : `M${top} A${r} ${r} 0 0 0 ${bottom} A${rx} ${r} 0 0 ${gibbous ? 0 : 1} ${top}Z`;
}
