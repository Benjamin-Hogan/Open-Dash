// Text/markdown-ish note. Renders plain text (newlines preserved); no HTML
// injection — content is set via textContent.
import { define } from "./registry.js";
import { el } from "./dom.js";

define("text", {
  meta: { label: "Text", description: "A note or label", category: "basic" },
  schema: {
    fields: [
      { key: "content", label: "Content", type: "textarea", required: true },
      { key: "align", label: "Align", type: "select", options: ["left", "center", "right"], default: "left" },
      { key: "size", label: "Font size (px)", type: "number", default: 18 },
    ],
  },
  async mount(root, widget) {
    const s = widget.settings || {};
    const div = el("div", {
      class: "text-widget",
      style: { textAlign: s.align || "left", fontSize: `${s.size || 18}px` },
    });
    div.textContent = s.content || "";
    root.appendChild(div);
    return { div };
  },
});
