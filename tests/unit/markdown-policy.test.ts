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

test("rejects percent-decoded image traversal at every encoding layer", () => {
  for (const target of [
    "/images/%2e%2e/private.webp",
    "/images/%2E%2e%2fprivate.webp",
    "/images/%252e%252e%252fprivate.webp",
    "/images/%25252e%25252e%25255cprivate.webp",
    "/images/%2e%2e%5cprivate.webp"
  ]) {
    const result = validatePublishableMarkdown(`![kapak](${target})`);
    assert.ok(
      result.blockers.includes("IMAGE_PATH_OUTSIDE_ALLOWLIST"),
      `${target}: ${JSON.stringify(result)}`
    );
  }
});

test("fails image targets closed on malformed or undecodable percent escapes", () => {
  for (const target of ["/images/%hero.webp", "/images/%2.webp", "/images/%25.webp"]) {
    const result = validatePublishableMarkdown(`![kapak](${target})`);
    assert.ok(
      result.blockers.includes("IMAGE_PATH_OUTSIDE_ALLOWLIST"),
      `${target}: ${JSON.stringify(result)}`
    );
  }
});

test("pins the accepted local image target forms without a parent-directory alias", () => {
  assert.deepEqual(validatePublishableMarkdown("![kapak](/images/hero.webp)").blockers, []);
  assert.deepEqual(validatePublishableMarkdown("![kapak](./images/hero.avif)").blockers, []);
  assert.ok(
    validatePublishableMarkdown("![kapak](../images/hero.png)")
      .blockers.includes("IMAGE_PATH_OUTSIDE_ALLOWLIST")
  );
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

test("an inline tilde run cannot hide raw HTML from the policy", () => {
  // `~~~` opens a fenced code block only at the start of a line. Treating an
  // inline run as a fence let untrusted content blind every check below while
  // the payload was still published verbatim.
  const result = validatePublishableMarkdown(
    "Metin ~~~ <script>alert(1)</script> ~~~ devam ediyor.\n"
  );
  assert.ok(result.blockers.includes("RAW_HTML_FORBIDDEN"), JSON.stringify(result));
});

test("an inline tilde run cannot hide an unsafe link from the policy", () => {
  const result = validatePublishableMarkdown(
    "Metin ~~~ [tıkla](javascript:alert(1)) ~~~ devam ediyor.\n"
  );
  assert.ok(result.blockers.includes("UNSAFE_LINK_TARGET"), JSON.stringify(result));
});

test("an inline backtick code span stays exempt, because it really is a code span", () => {
  // A run of backticks does open a code span mid-line in CommonMark, so this
  // renders as literal text and is not a publishable link.
  const result = validatePublishableMarkdown(
    "Metin ``` [tıkla](javascript:alert(1)) ``` devam ediyor.\n"
  );
  assert.deepEqual(result.blockers, []);
});

test("an unterminated fence is still scanned instead of blinding the rest of the document", () => {
  const result = validatePublishableMarkdown(
    "```\nkod\n\n<script>alert(1)</script>\n"
  );
  assert.ok(result.blockers.includes("RAW_HTML_FORBIDDEN"), JSON.stringify(result));
});

test("a real fenced code block is still exempt from the raw HTML check", () => {
  const result = validatePublishableMarkdown(
    "Örnek:\n\n```html\n<script>alert(1)</script>\n```\n\nBitti.\n"
  );
  assert.deepEqual(result.blockers, []);
});

test("shortcut reference links and images are validated against their definition", () => {
  const link = validatePublishableMarkdown(
    "Ayrıntı için [tıkla] sayfasına bakın.\n\n[tıkla]: javascript:alert(1)\n"
  );
  assert.ok(link.blockers.includes("UNSAFE_LINK_TARGET"), JSON.stringify(link));

  const image = validatePublishableMarkdown(
    "![kapak]\n\n[kapak]: https://uzak.example/kapak.svg\n"
  );
  assert.ok(image.blockers.includes("REMOTE_IMAGE_FORBIDDEN"), JSON.stringify(image));
});
