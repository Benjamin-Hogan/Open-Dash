// Calendars shared by Up next and Week ahead: several iCal feeds, one colour
// each (a person, a household), merged into one list of events with real
// Date objects. Each feed goes through the "ical" provider (cached server-side).
import { fetchData } from "./dom.js";
import { parseWhen } from "./fmt.js";

export const TAG_COLOURS = [
  { value: "blue", label: "Blue" }, { value: "pink", label: "Pink" }, { value: "green", label: "Green" },
  { value: "amber", label: "Amber" }, { value: "purple", label: "Purple" }, { value: "grey", label: "Grey" },
];

/** The admin field: a list of { name, url, colour, holidays }. */
export const calendarsField = {
  key: "calendars", label: "Calendars", type: "list", itemLabel: "Calendar", addLabel: "+ Add a calendar",
  emptyText: "No calendars yet.",
  default: [],
  newItem: { name: "", url: "", colour: "blue", holidays: false },
  itemTitle: (c, i) => c.name || `Calendar ${i + 1}`,
  itemFields: [
    { key: "name", label: "Whose (shown as \"Now · Maya\")", type: "text", placeholder: "Maya" },
    { key: "url", label: "iCal link (.ics, the calendar's secret or public address)", type: "text", required: true, placeholder: "https://…/basic.ics" },
    { key: "colour", label: "Colour", type: "select", options: TAG_COLOURS, default: "blue" },
    { key: "holidays", label: "This is a holidays calendar", type: "boolean", help: "Its events are outlined, and give way first when space is short." },
  ],
};

export const usable = (settings) => (settings?.calendars || []).filter((c) => c?.url?.trim());

/**
 * Every event from every calendar, soonest first:
 * [{ title, where, start: Date, end: Date, allDay, cal: { name, colour, holidays } }]
 * Throws only when every calendar failed (one bad feed doesn't blank the card).
 */
export async function loadEvents(settings, days = 8) {
  const cals = usable(settings);
  const results = await Promise.allSettled(cals.map((c) =>
    fetchData("ical", { url: c.url.trim(), count: 50, lookaheadDays: days })));
  if (cals.length && results.every((r) => r.status === "rejected")) throw new Error("no calendar loaded");
  const out = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const c = cals[i];
    const cal = { name: (c.name || "").trim(), colour: c.colour || "blue", holidays: !!c.holidays };
    for (const e of r.value.events || []) {
      const start = parseWhen(e.start);
      const end = e.end ? parseWhen(e.end) : new Date(start.getTime() + (e.allDay ? 86400000 : 0));
      if (Number.isNaN(start.getTime())) continue;
      out.push({ title: e.summary || "(no title)", where: e.location || "", start, end, allDay: !!e.allDay, cal });
    }
  });
  return out.sort((a, b) => a.start - b.start || (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0));
}
