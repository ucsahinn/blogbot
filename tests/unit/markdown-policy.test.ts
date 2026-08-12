import assert from "node:assert/strict";
import test from "node:test";

import { validatePublishableMarkdown } from "../../packages/security/src/markdown-policy.ts";

test("allows structured Markdown, fenced code, internal links, and HTTPS citations", () => {
  const result = validatePublishableMarkdown(`
# Başlık

Kısa paragraf ve [birincil kaynak](https://www.cisa.gov/news-events).

## Adımlar

- Bir
- İki

\`\`\`powershell
Get-Process
\`\`\`

![Özgün kapak](/images/story-16x9.webp)
  `);

  assert.deepEqual(result, { valid: true, blockers: [] });
});

for (const [name, markdown, blocker] of [
  ["raw HTML", "<iframe src=\"https://evil.example\"></iframe>", "RAW_HTML_FORBIDDEN"],
  ["script", "<script>alert(1)</script>", "RAW_HTML_FORBIDDEN"],
  ["javascript link", "[tıkla](javascript:alert(1))", "UNSAFE_LINK_TARGET"],
  ["data link", "[tıkla](data:text/html;base64,AAA)", "UNSAFE_LINK_TARGET"],
  ["remote image", "![kopya](https://source.example/photo.jpg)", "REMOTE_IMAGE_FORBIDDEN"],
  [
    "reference-style javascript link",
    "[tıkla][zararli]\n\n[zararli]: javascript:alert(1)",
    "UNSAFE_LINK_TARGET"
  ],
  [
    "reference-style remote image",
    "![kopya][kapak]\n\n[kapak]: https://source.example/photo.jpg",
    "REMOTE_IMAGE_FORBIDDEN"
  ],
  ["SVG image", "![aktif](/images/cover.svg)", "UNSAFE_IMAGE_FORMAT"],
  ["MDX import", "import Widget from './Widget.tsx'", "MDX_FORBIDDEN"]
] as const) {
  test(`rejects ${name}`, () => {
    assert.ok(validatePublishableMarkdown(markdown).blockers.includes(blocker));
  });
}

test("rejects image paths that escape the image directory through dot segments", () => {
  const result = validatePublishableMarkdown("![kapak](../images/../private.webp)");
  assert.ok(result.blockers.includes("IMAGE_PATH_OUTSIDE_ALLOWLIST"));
});

test("invalid numeric entities are handled as unsafe targets instead of throwing", () => {
  assert.doesNotThrow(() => validatePublishableMarkdown("[kaynak](jav&#x110000;ascript:alert(1))"));
  const result = validatePublishableMarkdown("[kaynak](jav&#x110000;ascript:alert(1))");
  assert.ok(result.blockers.includes("UNSAFE_LINK_TARGET"));
});

test("surrogate numeric entities are handled as unsafe targets instead of throwing", () => {
  assert.doesNotThrow(() => validatePublishableMarkdown("[kaynak](jav&#xD800;ascript:alert(1))"));
  const result = validatePublishableMarkdown("[kaynak](jav&#xD800;ascript:alert(1))");
  assert.ok(result.blockers.includes("UNSAFE_LINK_TARGET"));
});
