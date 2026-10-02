// Reminders — the household's rhythm: bins, plants, filters, medicine. Rules
// are "every Friday", "every other Friday from 2 Oct", "the 15th of every
// month", "every 2 Oct" or a one-off date. On the day, a reminder takes the
// amber band at the top ("Tonight" for evening ones, like bin night); the rest
// are listed by how soon. No network.
import { define } from "./registry.js";
import { el, stateView } from "./dom.js";
import { day, nb, daysBetween } from "./fmt.js";
import { TAG_COLOURS } from "./calendars.js";

export const ICONS = {
  bin: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  recycle: '<path d="M7 19H4.5a1.5 1.5 0 0 1-1.3-2.3L5.5 13M17 19h2.5a1.5 1.5 0 0 0 1.3-2.3L18.5 13M10 5.5l1.2-2a1 1 0 0 1 1.6 0l2.4 4M14 19H9M6 13l-1 1.7M18 13l-3.5-6M8.5 9 11 5"/>',
  plant: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  filter: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h10"/>',
  pill: '<rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-35 12 12)"/><path d="m9.5 8.5 5 7"/>',
  pet: '<circle cx="7" cy="9" r="1.8"/><circle cx="11" cy="6" r="1.8"/><circle cx="15" cy="6.5" r="1.8"/><circle cx="18" cy="10" r="1.8"/><path d="M8 17c0-3 2-5 4.5-5S17 14 17 17c0 2-2 2.5-4.5 2S8 19 8 17z"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/>',
};
const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const itemFields = (r) => {
  const f = [
    { key: "label", label: "What", type: "text", required: true, placeholder: "Trash out" },
    { key: "repeat", label: "Repeats", type: "select", default: "weekly", options: [
      { value: "weekly", label: "Every week" }, { value: "weeks", label: "Every few weeks" },
      { value: "monthly", label: "Every month" }, { value: "yearly", label: "Every year" }, { value: "once", label: "Once" },
    ] },
  ];
  const rep = r?.repeat || "weekly";
  if (rep === "weekly") f.push({ key: "weekday", label: "On", type: "select", default: 0, options: WEEKDAYS.map((d, i) => ({ value: String(i), label: d })) });
  if (rep === "weeks") f.push(
    { key: "every", label: "Every how many weeks", type: "number", default: 2, min: 2, max: 12 },
    { key: "date", label: "Starting on", type: "date", required: true, help: "Any date it happens; it repeats from there." });
  if (rep === "monthly") f.push({ key: "dayOfMonth", label: "Day of the month", type: "number", default: 1, min: 1, max: 31, help: "31 means the last day of shorter months." });
  if (rep === "yearly" || rep === "once") f.push({ key: "date", label: "Date", type: "date", required: true });
  f.push(
    { key: "evening", label: "It's done in the evening", type: "boolean", help: "Shows \"Tonight\" instead of \"Today\", like bin night." },
    { key: "icon", label: "Icon", type: "select", default: "bell", options: Object.keys(ICONS).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })) },
    { key: "colour", label: "Colour", type: "select", default: "grey", options: TAG_COLOURS },
  );
  return f;
};

define("reminders", {
  meta: {
    label: "Reminders",
    description: "Bin night, plants, filters: recurring chores, with today's in amber",
    category: "basic",
    showTitle: false,
  },
  schema: {
    fields: [
      {
        key: "reminders", label: "Reminders", type: "list", itemLabel: "Reminder", addLabel: "+ Add a reminder",
        emptyText: "No reminders yet.",
        default: [],
        newItem: { label: "", repeat: "weekly", weekday: "0", evening: false, icon: "bell", colour: "grey" },
        itemTitle: (r, i) => r.label || `Reminder ${i + 1}`,
        itemFields,
      },
    ],
  },
  async mount(root, widget) {
    const body = el("div", { class: "reminders" });
    root.appendChild(body);
    const handle = { body, widget };
    render(handle);
    handle.timer = setInterval(() => render(handle), 5 * 60000);
    return handle;
  },
  refresh(handle, widget) { if (widget) handle.widget = widget; render(handle); },
  suspend(handle) { clearInterval(handle.timer); handle.timer = null; },
  resume(handle) { if (!handle.timer) handle.timer = setInterval(() => render(handle), 5 * 60000); render(handle); },
  destroy(handle) { clearInterval(handle.timer); },
});

const ymd = (s) => {
  const [y, m, d] = String(s || "").split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};
const lastOfMonth = (y, m) => new Date(y, m + 1, 0).getDate();

/** The next date (today or later) a reminder is due, or null. Exported for tests. */
export function nextDue(r, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (r?.repeat || "weekly") {
    case "weekly": {
      const want = Number(r.weekday ?? 0); // 0 = Monday
      const have = (today.getDay() + 6) % 7;
      return new Date(today.getFullYear(), today.getMonth(), today.getDate() + ((want - have + 7) % 7));
    }
    case "weeks": {
      const start = ymd(r.date);
      const step = Math.max(1, Number(r.every) || 2) * 7;
      if (!start) return null;
      const gap = Math.round((today - start) / 86400000);
      const k = gap <= 0 ? 0 : Math.ceil(gap / step);
      return new Date(start.getFullYear(), start.getMonth(), start.getDate() + k * step);
    }
    case "monthly": {
      const want = Math.max(1, Math.min(31, Number(r.dayOfMonth) || 1));
      for (let k = 0; k < 2; k++) {
        const y = today.getFullYear(), m = today.getMonth() + k;
        const d = new Date(y, m, Math.min(want, lastOfMonth(y, m)));
        if (d >= today) return d;
      }
      return null;
    }
    case "yearly": {
      const d0 = ymd(r.date);
      if (!d0) return null;
      // 29 Feb falls back to 28 Feb in other years.
      const at = (y) => new Date(y, d0.getMonth(), Math.min(d0.getDate(), lastOfMonth(y, d0.getMonth())));
      const d = at(today.getFullYear());
      return d >= today ? d : at(today.getFullYear() + 1);
    }
    case "once": {
      const d = ymd(r.date);
      return d && d >= today ? d : null;
    }
    default: return null;
  }
}

/** { hero: { word, items } | null, rest: [{ r, due }] }. Exported for tests. */
export function arrange(reminders, now = new Date()) {
  const list = (reminders || [])
    .filter((r) => r?.label?.trim())
    .map((r) => ({ r, due: nextDue(r, now) }))
    .filter((x) => x.due)
    .sort((a, b) => a.due - b.due || a.r.label.localeCompare(b.r.label));
  const today = list.filter((x) => daysBetween(x.due, now) === 0);
  if (!today.length) return { hero: null, rest: list };
  // Daytime ones first ("Today"), evening ones ("Tonight") after; one banner per word.
  const dayItems = today.filter((x) => !x.r.evening), nightItems = today.filter((x) => x.r.evening);
  const lead = dayItems.length ? dayItems : nightItems;
  return {
    hero: { word: lead === dayItems ? "Today" : "Tonight", items: lead },
    rest: list.filter((x) => !lead.includes(x)),
  };
}

const tag = (r, size) => el("span", {
  class: `tag ${size}`, style: { "--tc": `var(--tag-${r.colour || "grey"})` },
  html: `<svg viewBox="0 0 24 24">${ICONS[r.icon] || ICONS.bell}</svg>`,
});

/** "tomorrow", "Wednesday", "Thu 15 Oct". */
const nextWhen = (d, now) => { const t = day(d, now); return t === "Tomorrow" ? "tomorrow" : t; };

/** "Trash out & Recycling" — labels joined for the banner. */
const joined = (items) => items.map((x) => x.r.label.trim()).join(" & ");

function render(handle) {
  const now = new Date();
  const { hero, rest } = arrange(handle.widget.settings?.reminders, now);
  if (!hero && !rest.length) {
    handle.body.replaceChildren(stateView({
      icon: "list", title: "Reminders: nothing set up yet",
      body: "Bin night, plants, filters: add them in this widget's settings.", where: "Admin › Layout › Reminders",
    }));
    return;
  }
  const top = hero
    ? el("div", { class: "rm-hero" }, [
      el("div", { class: "rm-icons" }, hero.items.slice(0, 3).map((x) => tag(x.r, "lg"))),
      el("div", { class: "rm-hero-text" }, [el("div", { class: "rm-when" }, hero.word), el("div", { class: "rm-what" }, nb(joined(hero.items)))]),
    ])
    : el("div", { class: "rm-calm" }, [
      el("span", { class: "ok-badge", html: CHECK }),
      el("div", {}, [
        el("div", { class: "rm-what" }, "Nothing due today"),
        rest[0] ? el("div", { class: "rm-sub" }, `Next: ${rest[0].r.label.trim()}, ${nextWhen(rest[0].due, now)}`) : null,
      ]),
    ]);
  const rows = rest.map((x) => el("div", { class: "rm-row" }, [
    tag(x.r, "md"),
    el("span", { class: "rm-n" }, nb(x.r.label.trim())),
    el("span", { class: "rm-d" + (daysBetween(x.due, now) <= 2 ? " soon" : "") }, day(x.due, now)),
  ]));
  handle.body.classList.toggle("has-hero", !!hero);
  // A short card in its "today" state goes amber all over (not a box in a box).
  handle.body.closest(".card")?.classList.toggle("rm-amber", !!hero && handle.body.clientHeight < 200);
  handle.body.replaceChildren(top, el("div", { class: "rm-list" }, rows));
  // Rows that don't fit whole are dropped (the soonest stay).
  const list = handle.body.querySelector(".rm-list");
  list.style.alignContent = "start"; // see service-status.js: measure overflow top-aligned
  while (list.children.length && list.scrollHeight > list.clientHeight + 1) list.lastElementChild.remove();
  list.style.alignContent = "";
}
