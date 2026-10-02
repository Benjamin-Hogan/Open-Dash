// Text/markdown-ish note. Renders plain text (newlines preserved); no HTML
// injection — content is set via textContent.
import { define } from "./registry.js";
import { el } from "./dom.js";

define("text", {
  meta: { label: "Text", description: "A note or label", category: "basic", showTitle: false },
  schema: {
    fields: [
      {
        key: "content", label: "Content", type: "textarea", required: true,
        help: "{host} becomes this display's address and {admin} the admin link, e.g. http://192.168.1.20:8081.",
      },
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
    div.textContent = fillTokens(s.content || "");
    root.appendChild(div);
    return { div };
  },
});

/** Replace {host} / {admin} with this display's real address. The original
 *  seed shipped a literal "<pi>" placeholder; treat that the same way so
 *  existing welcome notes stop showing it. */
function fillTokens(text) {
  const host = location.hostname || "localhost";
  const admin = `${location.protocol}//${host}:8081`;
  return text
    .replaceAll("{admin}", admin)
    .replaceAll("{host}", host)
    .replaceAll("http://<pi>:8081", admin)
    .replaceAll("<pi>", host);
}
