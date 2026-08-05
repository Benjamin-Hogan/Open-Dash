// One renderer for every field in the admin.
//
// The contract that matters: controls write straight into the draft object as
// the user edits. There is no gather step and nothing to scrape, so a field
// that isn't rendered is never touched (the old gatherSlideshow rebuilt each
// slide as {type,title,settings} and silently dropped everything else), and a
// reordered list keeps each item's values because items are identified by
// position in a real array rather than by a `ss-3-set-apiKey` name.

import { getPath, setPath } from "../core/clone.js";
import { visible, byGroup, groupLabel, VALUELESS, CUSTOM_WIDGET_TYPES } from "./schema.js";
import { validate, byPath } from "./validate.js";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * @param host   element to render into (cleared)
 * @param defs   FieldDef[]
 * @param draft  the object being edited — mutated in place
 * @param opts   { onChange, custom: {typeName: (ctx) => Node} }
 * @returns {{ getValue, validate, setErrors, focusField, rerender }}
 */
export function renderForm(host, defs, draft, opts = {}) {
  const { onChange = () => {}, custom = {} } = opts;
  const controls = new Map(); // path -> { wrap, input, setError }

  function change(path) {
    onChange(path, draft);
  }

  function fieldWrap(f, control, { inline = false } = {}) {
    const wrap = el("div", "field" + (inline ? " field-inline" : ""));
    if (f.label && f.type !== "boolean") {
      const label = el("label", null, f.label);
      label.htmlFor = control.id || "";
      if (f.required) label.appendChild(el("span", "req", " *"));
      wrap.appendChild(label);
    }
    wrap.appendChild(control);
    if (f.help) wrap.appendChild(el("div", "note", f.help));
    const err = el("div", "field-error");
    err.hidden = true;
    wrap.appendChild(err);
    // Custom field types (url-presets, embed-presets, stock-picker) hand back a
    // wrapper, so aim the a11y state and focus at the control inside it.
    const focusable = control.matches?.("input, select, textarea")
      ? control
      : control.querySelector?.("input, select, textarea") || control;
    controls.set(f.key, {
      wrap, input: focusable,
      setError(msgs) {
        const has = msgs && msgs.length;
        err.hidden = !has;
        err.textContent = has ? msgs[0] : "";
        wrap.classList.toggle("invalid", !!has);
        focusable.setAttribute?.("aria-invalid", has ? "true" : "false");
        if (has) focusable.setAttribute?.("aria-errormessage", err.id || "");
      },
    });
    return wrap;
  }

  function makeControl(f) {
    const value = getPath(draft, f.key);
    const id = "f_" + f.key.replace(/[^a-z0-9]+/gi, "_");

    switch (f.type) {
      case "note":
        return el("div", "note", f.label);

      case "boolean": {
        // A switch, but still a real checkbox underneath for a11y and forms.
        const wrap = el("label", "switch");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.id = id;
        input.checked = value === true || value === "true";
        input.onchange = () => { setPath(draft, f.key, input.checked); change(f.key); };
        wrap.append(input, el("span", "switch-track"), el("span", "switch-label", f.label));
        return wrap;
      }

      case "textarea": {
        const input = document.createElement("textarea");
        input.id = id;
        input.value = value ?? "";
        if (f.placeholder) input.placeholder = f.placeholder;
        input.oninput = () => { setPath(draft, f.key, input.value); change(f.key); };
        return input;
      }

      case "select": {
        const input = document.createElement("select");
        input.id = id;
        for (const o of f.options || []) {
          const opt = document.createElement("option");
          opt.value = typeof o === "object" ? o.value : o;
          opt.textContent = typeof o === "object" ? o.label : o;
          input.appendChild(opt);
        }
        input.value = value ?? f.default ?? "";
        input.onchange = () => { setPath(draft, f.key, input.value); change(f.key); };
        return input;
      }

      case "number": {
        const input = document.createElement("input");
        input.type = "number";
        input.id = id;
        input.value = value ?? "";
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        if (f.step !== undefined) input.step = f.step;
        if (f.placeholder) input.placeholder = f.placeholder;
        input.oninput = () => {
          // Blank means "unset", not zero — several fields treat null as
          // "inherit the default".
          setPath(draft, f.key, input.value === "" ? null : Number(input.value));
          change(f.key);
        };
        return input;
      }

      case "grid":
        return gridControl(f, id);

      case "list":
        return listControl(f);

      default: {
        // text, password, color, time, date, url…
        const input = document.createElement("input");
        input.type = ["password", "color", "time", "date", "search"].includes(f.type) ? f.type : "text";
        input.id = id;
        input.value = value ?? "";
        if (f.placeholder) input.placeholder = f.placeholder;
        if (f.type === "password") {
          input.autocomplete = "off";
          // Blank means "keep what the server already has" — the value never
          // comes back from GET /api/config.
          input.placeholder = f.placeholder || "unchanged";
        }
        input.oninput = () => { setPath(draft, f.key, input.value); change(f.key); };
        return input;
      }
    }
  }

  /** Numeric x/y/w/h. The canvas is still the main way to place a widget, but
   *  there was previously no way to type an exact position at all. */
  function gridControl(f, id) {
    const wrap = el("div", "grid-fields");
    const g = getPath(draft, f.key) || {};
    for (const [k, label, min] of [["x", "X", 0], ["y", "Y", 0], ["w", "W", 1], ["h", "H", 1]]) {
      const cell = el("div", "grid-cell");
      const lab = el("label", null, label);
      const input = document.createElement("input");
      input.type = "number";
      input.id = `${id}_${k}`;
      input.min = min;
      input.value = g[k] ?? min;
      lab.htmlFor = input.id;
      input.oninput = () => {
        const n = Math.max(min, Math.round(Number(input.value) || min));
        setPath(draft, `${f.key}.${k}`, n);
        change(f.key);
      };
      cell.append(lab, input);
      wrap.appendChild(cell);
    }
    return wrap;
  }

  /** A repeatable list of sub-forms (schedule windows, variants, slides).
   *  Items are plain array entries, so reordering moves the values with them. */
  function listControl(f) {
    const wrap = el("div", "list-editor");
    const items = getPath(draft, f.key) || [];
    if (!Array.isArray(getPath(draft, f.key))) setPath(draft, f.key, items);

    const redraw = () => {
      wrap.replaceChildren();
      if (!items.length) wrap.appendChild(el("div", "note", f.emptyText || "None yet."));

      items.forEach((item, i) => {
        const card = el("div", "list-card");
        const head = el("div", "list-card-head");
        head.appendChild(el("strong", null,
          typeof f.itemTitle === "function" ? f.itemTitle(item, i) : `${f.itemLabel || "Item"} ${i + 1}`));

        const tools = el("div", "list-card-tools");
        const mk = (txt, title, fn, cls = "") => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn small ghost " + cls;
          b.textContent = txt;
          b.title = title;
          b.onclick = fn;
          return b;
        };
        tools.append(
          mk("↑", "Move up", () => {
            if (i <= 0) return;
            [items[i - 1], items[i]] = [items[i], items[i - 1]];
            redraw(); change(f.key);
          }),
          mk("↓", "Move down", () => {
            if (i >= items.length - 1) return;
            [items[i + 1], items[i]] = [items[i], items[i + 1]];
            redraw(); change(f.key);
          }),
          mk("Remove", "Remove", () => { items.splice(i, 1); redraw(); change(f.key); }, "danger"),
        );
        head.appendChild(tools);
        card.appendChild(head);

        const itemDefs = (typeof f.itemFields === "function" ? f.itemFields(item, i) : f.itemFields) || [];
        const scoped = itemDefs.map((d) => ({ ...d, key: `${f.key}.${i}.${d.key}` }));
        for (const sub of visible(scoped, draft)) card.appendChild(renderOne(sub));
        wrap.appendChild(card);
      });

      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn small";
      add.textContent = f.addLabel || "+ Add";
      add.onclick = async () => {
        const item = typeof f.newItem === "function" ? await f.newItem() : { ...(f.newItem || {}) };
        if (item == null) return;
        items.push(item);
        redraw(); change(f.key);
      };
      wrap.appendChild(add);
    };
    redraw();
    return wrap;
  }

  function renderOne(f) {
    if (f.type === "custom" && typeof f.render === "function") {
      return f.render({ draft, field: f, get: () => getPath(draft, f.key), set: (v) => { setPath(draft, f.key, v); change(f.key); }, change: () => change(f.key) });
    }
    if (CUSTOM_WIDGET_TYPES.has(f.type) && custom[f.type]) {
      const node = custom[f.type]({ draft, field: f, get: () => getPath(draft, f.key), set: (v) => { setPath(draft, f.key, v); change(f.key); } });
      return fieldWrap(f, node);
    }
    const control = makeControl(f);
    if (VALUELESS.has(f.type)) return fieldWrap({ ...f, label: null }, control);
    if (f.type === "boolean") return fieldWrap({ ...f, label: null }, control);
    return fieldWrap(f, control);
  }

  function draw() {
    host.replaceChildren();
    controls.clear();
    for (const chunk of byGroup(visible(defs, draft))) {
      if (!chunk.group) {
        for (const f of chunk.fields) host.appendChild(renderOne(f));
        continue;
      }
      // A group becomes a collapsible fieldset. iframe's three `group:"embed"`
      // fields have carried this metadata all along with nothing reading it.
      const details = document.createElement("details");
      details.className = "field-group";
      const summary = document.createElement("summary");
      summary.textContent = groupLabel(chunk.group);
      details.appendChild(summary);
      for (const f of chunk.fields) details.appendChild(renderOne(f));
      host.appendChild(details);
    }
  }

  draw();

  return {
    getValue: () => draft,
    validate: () => validate(defs, draft),
    rerender: draw,
    setErrors(errors) {
      const map = byPath(errors || []);
      for (const [path, c] of controls) c.setError(map.get(path));
      return map;
    },
    focusField(path) {
      const c = controls.get(path);
      if (!c) return false;
      c.wrap.scrollIntoView({ block: "center", behavior: "smooth" });
      c.input.focus?.();
      // Open the fieldset if the field is inside a collapsed group.
      c.wrap.closest("details")?.setAttribute("open", "");
      return true;
    },
  };
}
