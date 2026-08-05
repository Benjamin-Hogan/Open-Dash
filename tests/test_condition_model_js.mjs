// Node smoke tests for admin/js/model/condition.js — the trigger rules that
// used to live inside a redraw closure and a DOM-reading gatherCondition().
import assert from "node:assert/strict";
import {
  toDraft, fromDraft, defaultPriority, describe, SOURCE_TYPE, TYPES,
} from "../admin/js/model/condition.js";

// ---- default priority -------------------------------------------------------
{
  // A weather emergency should outrank a printer, which outranks a stream.
  assert.equal(defaultPriority("weather-alert"), 90);
  assert.equal(defaultPriority("octoprint", ["error"]), 80);
  assert.equal(defaultPriority("octoprint", ["printing"]), 50);
  assert.equal(defaultPriority("octoprint", ["printing", "error"]), 80,
    "any error state raises the printer's priority");
  assert.equal(defaultPriority("youtube-live"), 40);
  assert.equal(defaultPriority("calendar-soon"), 30);
  assert.equal(defaultPriority("something-new"), 50, "an unknown trigger still gets a number");
}

// ---- toDraft fills everything in -------------------------------------------
{
  const d = toDraft(null);
  assert.equal(d.enabled, false);
  assert.equal(d.type, "octoprint");
  assert.equal(d.mode, "soft-join");
  assert.deepEqual(d.matchStates, ["printing"]);
  assert.equal(d.priority, 50);
  assert.equal(d.leadMinutes, 30);
  assert.equal(d.pollSeconds, null);

  const stored = { enabled: true, type: "calendar-soon", mode: "force-override", priority: 77, leadMinutes: 15 };
  const d2 = toDraft(stored);
  assert.equal(d2.priority, 77, "an explicit priority is preserved");
  assert.equal(d2.leadMinutes, 15);

  // The draft must not alias the stored object.
  const src = { enabled: true, type: "octoprint", matchStates: ["printing"] };
  const copy = toDraft(src);
  copy.matchStates.push("error");
  assert.deepEqual(src.matchStates, ["printing"], "editing the draft must not touch the config");
}

// ---- disabled stores nothing ------------------------------------------------
{
  assert.equal(fromDraft(toDraft(null)), null);
  assert.equal(fromDraft({ ...toDraft(null), enabled: false, priority: 90 }), null,
    "a disabled condition is null however it was filled in");
}

// ---- only the chosen trigger's fields are written --------------------------
{
  // A draft carrying leftovers from every trigger type.
  const messy = {
    ...toDraft(null),
    enabled: true,
    sourceWidgetId: "op-1",
    matchStates: ["printing", "error"],
    minSeverity: "warning",
    leadMinutes: 45,
  };

  const octo = fromDraft({ ...messy, type: "octoprint" });
  assert.deepEqual(octo.matchStates, ["printing", "error"]);
  assert.equal(octo.sourceWidgetId, "op-1");
  assert.equal("minSeverity" in octo, false, "a stale severity must not survive");
  assert.equal("leadMinutes" in octo, false);

  const weather = fromDraft({ ...messy, type: "weather-alert" });
  assert.equal(weather.minSeverity, "warning");
  assert.equal("sourceWidgetId" in weather, false,
    "a weather alert has no source widget — a stale id would confuse the evaluator");
  assert.equal("matchStates" in weather, false);

  const yt = fromDraft({ ...messy, type: "youtube-live" });
  assert.equal(yt.sourceWidgetId, "op-1");
  assert.equal("matchStates" in yt, false);

  const cal = fromDraft({ ...messy, type: "calendar-soon" });
  assert.equal(cal.leadMinutes, 45);
  assert.equal(cal.sourceWidgetId, "op-1");
  assert.equal("minSeverity" in cal, false);
}

// ---- clamping ---------------------------------------------------------------
{
  const base = { ...toDraft(null), enabled: true, type: "octoprint" };
  assert.equal(fromDraft({ ...base, priority: 999 }).priority, 100);
  assert.equal(fromDraft({ ...base, priority: -5 }).priority, 0);
  assert.equal(fromDraft({ ...base, priority: "" }).priority, 50,
    "an unparseable priority falls back to the trigger's default");
  assert.equal(fromDraft({ ...base, priority: "", matchStates: ["error"] }).priority, 80);

  assert.equal(fromDraft({ ...base, pollSeconds: null }).pollSeconds, null);
  assert.equal(fromDraft({ ...base, pollSeconds: "" }).pollSeconds, null);
  assert.equal(fromDraft({ ...base, pollSeconds: 1 }).pollSeconds, 2, "below the floor clamps up");
  assert.equal(fromDraft({ ...base, pollSeconds: 9999 }).pollSeconds, 300);

  const cal = { ...base, type: "calendar-soon" };
  assert.equal(fromDraft({ ...cal, leadMinutes: 0 }).leadMinutes, 1);
  assert.equal(fromDraft({ ...cal, leadMinutes: 99999 }).leadMinutes, 10080, "capped at a week");
  assert.equal(fromDraft({ ...cal, leadMinutes: "abc" }).leadMinutes, 30);
}

// ---- empty match states never save empty ------------------------------------
{
  const out = fromDraft({ ...toDraft(null), enabled: true, type: "octoprint", matchStates: [] });
  assert.deepEqual(out.matchStates, ["printing"],
    "an empty selection would never match anything, so it falls back");
}

// ---- round trip -------------------------------------------------------------
{
  const original = {
    enabled: true, type: "octoprint", mode: "force-override", priority: 80,
    pollSeconds: 10, sourceWidgetId: "op-1", matchStates: ["printing", "error"],
  };
  assert.deepEqual(fromDraft(toDraft(original)), original, "a round trip is lossless");
}

// ---- source widget mapping --------------------------------------------------
{
  assert.equal(SOURCE_TYPE["octoprint"], "octoprint");
  assert.equal(SOURCE_TYPE["calendar-soon"], "ical", "a calendar trigger reads an iCal widget");
  assert.equal(SOURCE_TYPE["weather-alert"], undefined, "weather has no source widget");
  assert.equal(TYPES.length, 4);
}

// ---- describe ---------------------------------------------------------------
{
  assert.equal(describe(null), null);
  assert.equal(describe({ enabled: false, type: "octoprint" }), null);
  assert.equal(
    describe({ enabled: true, type: "octoprint", matchStates: ["printing", "error"], mode: "soft-join" }),
    "OctoPrint (printer state) · printing/error",
  );
  assert.ok(
    describe({ enabled: true, type: "weather-alert", minSeverity: "danger", mode: "force-override", priority: 90 })
      .includes("override p90"),
    "an overriding condition says so, since it pre-empts everything else",
  );
}

console.log("condition model: ok");
